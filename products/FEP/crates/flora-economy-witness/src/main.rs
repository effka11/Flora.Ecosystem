//! Reference-демон витнесса LIV — независимый наблюдатель журнала FEP (LIV.md §4.4).
//!
//! Цикл наблюдения:
//! 1. `GET /api/economy/ledger/sth` — текущий head;
//! 2. против запомненного head: размер не уменьшился; при равном размере head совпадает;
//!    при росте — consistency-доказательство проверяется **ядром** (RFC 9162);
//! 3. опционально `--full-replay`: полный реплей журнала детерминированным движком;
//! 4. косайн head (Ed25519, доменная метка STH) и `POST /api/economy/ledger/cosigns`;
//! 5. head сохраняется в state-файл — базис следующей проверки.
//!
//! Любое расхождение — **доказуемый инцидент** (двусмысленность истории или отказ
//! сервера доказать append-only): демон пишет incident-файл с уликами, отказывается
//! косайнить и завершает работу кодом 2. Код 1 — операционная ошибка (сеть, диск):
//! не улика, просто повторить позже.
//!
//! Криптографика целиком в `flora-economy-crypto`; здесь — только IO и политика.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use flora_economy_crypto::engine::LedgerState;
use flora_economy_crypto::hash::{Hash32, to_hex};
use flora_economy_crypto::ledger::{LedgerEntry, LedgerHead};
use flora_economy_crypto::sig::public_key;
use flora_economy_crypto::witness::{HeadCosign, cosign_head};
use flora_economy_crypto::{merkle, witness};
use serde::{Deserialize, Serialize};

#[derive(Parser)]
#[command(
    name = "flora-economy-witness",
    about = "Reference-витнесс журнала LIV (FEP): наблюдение, проверка append-only, косайнинг"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Сгенерировать ключ витнесса (32-байтовый seed, hex) и напечатать публичный ключ.
    Keygen {
        /// Файл seed (hex, 64 символа). Публичный ключ печатается в stdout.
        #[arg(long)]
        seed_file: PathBuf,
        /// Перезаписать существующий файл.
        #[arg(long, default_value_t = false)]
        force: bool,
    },
    /// Один цикл наблюдения (LIV.md §4.4). Код 0 — ок, 1 — операционная ошибка, 2 — инцидент.
    Observe {
        #[command(flatten)]
        opts: ObserveOpts,
    },
    /// Наблюдение в цикле с интервалом; инцидент останавливает демон (код 2).
    Run {
        #[command(flatten)]
        opts: ObserveOpts,
        /// Интервал между циклами, секунды.
        #[arg(long, default_value_t = 60)]
        interval_secs: u64,
    },
}

#[derive(clap::Args)]
struct ObserveOpts {
    /// База сервера экономики, например https://flora.example.
    #[arg(long)]
    server: String,
    /// Файл seed витнесса (hex, 64 символа) — см. `keygen`.
    #[arg(long)]
    seed_file: PathBuf,
    /// State-файл с последним подписанным head (создаётся при первом запуске).
    #[arg(long)]
    state_file: PathBuf,
    /// Полный реплей журнала детерминированным ядром (L2) перед косайном.
    #[arg(long, default_value_t = false)]
    full_replay: bool,
    /// Проверить, но не отправлять косайн на сервер.
    #[arg(long, default_value_t = false)]
    no_submit: bool,
    /// Bearer-токен, если развёртывание требует авторизацию на /api/economy/*.
    #[arg(long)]
    bearer: Option<String>,
}

// ---------- контракты HTTP-ответов (LIV.md §6) ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SthResponse {
    head: LedgerHead,
    #[allow(dead_code)]
    witnesses: Vec<String>,
    #[allow(dead_code)]
    cosigns: Vec<HeadCosign>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyResponse {
    old_size: u64,
    new_size: u64,
    old_root: String,
    new_root: String,
    proof: Vec<String>,
}

// ---------- состояние витнесса ----------

/// Последний head, который этот витнесс подписал, — базис проверки append-only.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WitnessState {
    head: LedgerHead,
    signature_hex: String,
    signed_at_ms: i64,
}

/// Улики инцидента: пишутся рядом со state-файлом, `exit 2`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Incident {
    reason: String,
    detail: String,
    trusted_head: Option<LedgerHead>,
    trusted_signature_hex: Option<String>,
    offered_head: LedgerHead,
    observed_at_ms: i64,
}

// ---------- чистая логика проверки (тестируется без сети) ----------

/// Вердикт одного цикла наблюдения.
enum Verdict {
    /// Head не изменился — подпись уже опубликована ранее.
    Unchanged,
    /// Head корректно вырос (или первый запуск) — косайнить и запомнить.
    Advance,
    /// Доказуемое расхождение — не косайнить, публиковать улики.
    Incident {
        reason: &'static str,
        detail: String,
    },
}

/// Hex lowercase для байтов произвольной длины (подписи — 64 байта, `to_hex` ядра — только 32).
fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_hash(hex: &str) -> Result<Hash32, String> {
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("zz"), 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| format!("некорректный hex: {hex}"))?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("ожидалось 32 байта: {hex}"))?;
    Ok(array)
}

/// Сверить предложенный head с запомненным; при росте — проверить consistency ядром.
fn evaluate_head(
    trusted: Option<&WitnessState>,
    offered: &LedgerHead,
    consistency: Option<&ConsistencyResponse>,
) -> Verdict {
    let Some(prev) = trusted else {
        // Первый запуск — TOFU: подписываем текущий head, дальше история под контролем.
        return Verdict::Advance;
    };
    let old = &prev.head;
    if offered.size < old.size {
        return Verdict::Incident {
            reason: "size_regression",
            detail: format!("журнал сжался: {} -> {}", old.size, offered.size),
        };
    }
    if offered.size == old.size {
        if offered.last_entry_hash != old.last_entry_hash || offered.merkle_root != old.merkle_root
        {
            return Verdict::Incident {
                reason: "same_size_different_head",
                detail: "другой head при том же размере журнала (переписана история)".into(),
            };
        }
        return Verdict::Unchanged;
    }
    // Рост: требуется криптографическое доказательство append-only.
    let Some(resp) = consistency else {
        return Verdict::Incident {
            reason: "missing_consistency_proof",
            detail: "сервер не предоставил consistency-доказательство".into(),
        };
    };
    let proof: Result<Vec<Hash32>, String> = resp.proof.iter().map(|h| parse_hash(h)).collect();
    let (Ok(proof), Ok(old_root), Ok(new_root)) = (
        proof,
        parse_hash(&resp.old_root),
        parse_hash(&resp.new_root),
    ) else {
        return Verdict::Incident {
            reason: "malformed_consistency_proof",
            detail: "не-hex данные в consistency-ответе".into(),
        };
    };
    if resp.old_size != old.size
        || resp.new_size != offered.size
        || old_root != old.merkle_root
        || new_root != offered.merkle_root
    {
        return Verdict::Incident {
            reason: "consistency_scope_mismatch",
            detail: format!(
                "доказательство не о наших деревьях: {}→{} vs {}→{}",
                resp.old_size, resp.new_size, old.size, offered.size
            ),
        };
    }
    if !merkle::verify_consistency(old.size, offered.size, &old_root, &new_root, &proof) {
        return Verdict::Incident {
            reason: "consistency_failed",
            detail: "consistency-доказательство не сходится: история переписана".into(),
        };
    }
    Verdict::Advance
}

/// Сверить head с результатом полного реплея журнала ядром (L2).
fn evaluate_replay(entries: &[LedgerEntry], offered: &LedgerHead) -> Verdict {
    match LedgerState::replay(entries) {
        Ok(state) if state.head == *offered => Verdict::Advance,
        Ok(state) => Verdict::Incident {
            reason: "replay_head_mismatch",
            detail: format!(
                "реплей даёт head size={} root={}, сервер утверждает size={} root={}",
                state.head.size,
                to_hex(&state.head.merkle_root),
                offered.size,
                to_hex(&offered.merkle_root)
            ),
        },
        Err(error) => Verdict::Incident {
            reason: "replay_rejected",
            detail: format!("журнал не проходит реплей ядром: {error}"),
        },
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- IO ----------

fn read_seed(path: &Path) -> Result<[u8; 32], String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("не прочитан seed-файл {}: {e}", path.display()))?;
    let hex = text.trim();
    if hex.len() != 64 {
        return Err("seed-файл обязан содержать 64 hex-символа".into());
    }
    parse_hash(hex).map_err(|e| format!("seed: {e}"))
}

fn write_seed(path: &Path, seed: &[u8; 32], force: bool) -> Result<(), String> {
    if path.exists() && !force {
        return Err(format!(
            "{} уже существует (перезапись — --force)",
            path.display()
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("не создан каталог: {e}"))?;
    }
    std::fs::write(path, to_hex(seed)).map_err(|e| format!("не записан seed-файл: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_state(path: &Path) -> Result<Option<WitnessState>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("не прочитан state-файл {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("повреждён state-файл {}: {e}", path.display()))
}

fn save_state(path: &Path, state: &WitnessState) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).expect("state сериализуем");
    std::fs::write(path, json).map_err(|e| format!("не записан state-файл: {e}"))
}

fn write_incident(
    state_file: &Path,
    trusted: Option<&WitnessState>,
    offered: &LedgerHead,
    reason: &str,
    detail: &str,
) -> PathBuf {
    let incident = Incident {
        reason: reason.into(),
        detail: detail.into(),
        trusted_head: trusted.map(|s| s.head.clone()),
        trusted_signature_hex: trusted.map(|s| s.signature_hex.clone()),
        offered_head: offered.clone(),
        observed_at_ms: now_ms(),
    };
    let path = state_file.with_extension(format!("incident-{}-{}.json", offered.size, now_ms()));
    let json = serde_json::to_string_pretty(&incident).expect("incident сериализуем");
    if let Err(error) = std::fs::write(&path, &json) {
        eprintln!("не записан incident-файл {}: {error}", path.display());
    }
    eprintln!("ИНЦИДЕНТ [{reason}]: {detail}");
    eprintln!("{json}");
    path
}

// ---------- сеть ----------

struct Client {
    http: reqwest::Client,
    base: String,
    bearer: Option<String>,
}

impl Client {
    fn new(server: &str, bearer: Option<String>) -> Client {
        Client {
            http: reqwest::Client::new(),
            base: server.trim_end_matches('/').to_string(),
            bearer,
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self.http.request(method, format!("{}{}", self.base, path));
        match &self.bearer {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        self.request(reqwest::Method::GET, path)
            .send()
            .await
            .map_err(|e| format!("GET {path}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GET {path}: {e}"))?
            .json::<T>()
            .await
            .map_err(|e| format!("GET {path}: некорректный JSON: {e}"))
    }

    async fn fetch_all_entries(&self) -> Result<Vec<LedgerEntry>, String> {
        let mut entries: Vec<LedgerEntry> = Vec::new();
        loop {
            let page: Vec<LedgerEntry> = self
                .get_json(&format!(
                    "/api/economy/ledger/entries?from={}&limit=500",
                    entries.len()
                ))
                .await?;
            if page.is_empty() {
                return Ok(entries);
            }
            entries.extend(page);
        }
    }

    async fn submit_cosign(&self, cosign: &HeadCosign) -> Result<(), (bool, String)> {
        let response = self
            .request(reqwest::Method::POST, "/api/economy/ledger/cosigns")
            .json(cosign)
            .send()
            .await
            .map_err(|e| (false, format!("POST cosigns: {e}")))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        // 4xx на валидный косайн текущего head — сервер отверг витнесса: улика (LIV.md §4.4).
        Err((
            status.is_client_error(),
            format!("POST cosigns: {status}: {body}"),
        ))
    }
}

// ---------- цикл наблюдения ----------

/// Один цикл наблюдения; `Ok(0)` — успех, `Ok(2)` — инцидент, `Err` — операционная ошибка.
async fn observe_once(opts: &ObserveOpts) -> Result<u8, String> {
    let seed = read_seed(&opts.seed_file)?;
    let trusted = load_state(&opts.state_file)?;
    let client = Client::new(&opts.server, opts.bearer.clone());

    let sth: SthResponse = client.get_json("/api/economy/ledger/sth").await?;
    let offered = sth.head;

    // Consistency-доказательство нужно только при росте относительно запомненного head.
    let consistency: Option<ConsistencyResponse> = match &trusted {
        Some(prev) if offered.size > prev.head.size => Some(
            client
                .get_json(&format!(
                    "/api/economy/ledger/consistency?oldSize={}&newSize={}",
                    prev.head.size, offered.size
                ))
                .await?,
        ),
        _ => None,
    };

    let mut verdict = evaluate_head(trusted.as_ref(), &offered, consistency.as_ref());

    if matches!(verdict, Verdict::Advance) && opts.full_replay {
        let entries = client.fetch_all_entries().await?;
        verdict = evaluate_replay(&entries, &offered);
    }

    match verdict {
        Verdict::Unchanged => {
            println!(
                "head не изменился (size={}), косайн уже опубликован",
                offered.size
            );
            Ok(0)
        }
        Verdict::Incident { reason, detail } => {
            write_incident(
                &opts.state_file,
                trusted.as_ref(),
                &offered,
                reason,
                &detail,
            );
            Ok(2)
        }
        Verdict::Advance => {
            let cosign = cosign_head(&offered, &seed);
            debug_assert!(witness::verify_head_cosign(&cosign).is_ok());
            if opts.no_submit {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&cosign).expect("сериализуемо")
                );
            } else if let Err((provable, message)) = client.submit_cosign(&cosign).await {
                if provable {
                    write_incident(
                        &opts.state_file,
                        trusted.as_ref(),
                        &offered,
                        "cosign_rejected",
                        &format!("сервер отверг валидный косайн своего head: {message}"),
                    );
                    return Ok(2);
                }
                return Err(message);
            }
            let signature_hex = hex_string(&cosign.signature);
            save_state(
                &opts.state_file,
                &WitnessState {
                    head: offered.clone(),
                    signature_hex,
                    signed_at_ms: now_ms(),
                },
            )?;
            println!(
                "косайн опубликован: size={} root={} witness={}",
                offered.size,
                to_hex(&offered.merkle_root),
                to_hex(&public_key(&seed)),
            );
            Ok(0)
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Keygen { seed_file, force } => {
            let mut seed = [0u8; 32];
            if let Err(error) = getrandom::fill(&mut seed) {
                eprintln!("CSPRNG недоступен: {error}");
                return ExitCode::FAILURE;
            }
            if let Err(error) = write_seed(&seed_file, &seed, force) {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
            println!("публичный ключ витнесса: {}", to_hex(&public_key(&seed)));
            println!("seed записан в {}", seed_file.display());
            ExitCode::SUCCESS
        }
        Command::Observe { opts } => match observe_once(&opts).await {
            Ok(code) => ExitCode::from(code),
            Err(error) => {
                eprintln!("операционная ошибка: {error}");
                ExitCode::FAILURE
            }
        },
        Command::Run {
            opts,
            interval_secs,
        } => {
            loop {
                match observe_once(&opts).await {
                    // Инцидент останавливает демон: косайнить скомпрометированный
                    // журнал нельзя, продолжение цикла легитимизировало бы форк.
                    Ok(2) => return ExitCode::from(2),
                    Ok(_) => {}
                    Err(error) => eprintln!("операционная ошибка (повтор позже): {error}"),
                }
                tokio::time::sleep(Duration::from_secs(interval_secs)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_economy_crypto::amount::{AccountId, Timestamp};
    use flora_economy_crypto::hash::ZERO_HASH;
    use flora_economy_crypto::ledger::EntryBody;
    use flora_economy_crypto::params::Parameters;

    fn journal(n_accounts: u8) -> Vec<LedgerEntry> {
        let mut entries = Vec::new();
        let mut prev = ZERO_HASH;
        let mut push = |entries: &mut Vec<LedgerEntry>, at: i64, body: EntryBody| {
            let entry = LedgerEntry {
                seq: entries.len() as u64,
                at: Timestamp(at),
                prev_hash: prev,
                body,
            };
            prev = entry.entry_hash();
            entries.push(entry);
        };
        push(
            &mut entries,
            1_700_000_000_000,
            EntryBody::Genesis {
                protocol_version: flora_economy_crypto::FEP_PROTOCOL_VERSION,
                params: Parameters::genesis(),
            },
        );
        for i in 0..n_accounts {
            push(
                &mut entries,
                1_700_000_000_000 + i64::from(i) + 1,
                EntryBody::AccountOpened {
                    account: AccountId([i + 1; 16]),
                    owner_key: public_key(&[i + 1; 32]),
                },
            );
        }
        entries
    }

    fn head_of(entries: &[LedgerEntry]) -> LedgerHead {
        LedgerState::replay(entries).expect("журнал валиден").head
    }

    fn state_for(head: &LedgerHead) -> WitnessState {
        let cosign = cosign_head(head, &[9u8; 32]);
        WitnessState {
            head: head.clone(),
            signature_hex: hex_string(&cosign.signature),
            signed_at_ms: 0,
        }
    }

    fn consistency_for(
        entries: &[LedgerEntry],
        old_size: u64,
        new_size: u64,
    ) -> ConsistencyResponse {
        let leaves: Vec<Hash32> = entries
            .iter()
            .map(|e| merkle::hash_leaf(&e.entry_hash()))
            .collect();
        let proof = merkle::consistency_proof(&leaves[..new_size as usize], old_size as usize)
            .expect("диапазон валиден");
        ConsistencyResponse {
            old_size,
            new_size,
            old_root: to_hex(&merkle::merkle_root(&leaves[..old_size as usize])),
            new_root: to_hex(&merkle::merkle_root(&leaves[..new_size as usize])),
            proof: proof.iter().map(to_hex).collect(),
        }
    }

    #[test]
    fn first_run_is_tofu_advance() {
        let entries = journal(2);
        assert!(matches!(
            evaluate_head(None, &head_of(&entries), None),
            Verdict::Advance
        ));
    }

    #[test]
    fn unchanged_head_needs_no_new_cosign() {
        let entries = journal(2);
        let head = head_of(&entries);
        let state = state_for(&head);
        assert!(matches!(
            evaluate_head(Some(&state), &head, None),
            Verdict::Unchanged
        ));
    }

    #[test]
    fn growth_with_valid_proof_advances() {
        let all = journal(3);
        let old = head_of(&all[..2]);
        let new = head_of(&all);
        let state = state_for(&old);
        let consistency = consistency_for(&all, old.size, new.size);
        assert!(matches!(
            evaluate_head(Some(&state), &new, Some(&consistency)),
            Verdict::Advance
        ));
    }

    #[test]
    fn growth_without_proof_is_incident() {
        let all = journal(3);
        let state = state_for(&head_of(&all[..2]));
        match evaluate_head(Some(&state), &head_of(&all), None) {
            Verdict::Incident { reason, .. } => assert_eq!(reason, "missing_consistency_proof"),
            _ => panic!("ожидался инцидент"),
        }
    }

    #[test]
    fn shrink_and_rewrite_are_incidents() {
        let all = journal(3);
        let big = head_of(&all);
        let small = head_of(&all[..2]);
        let state = state_for(&big);
        match evaluate_head(Some(&state), &small, None) {
            Verdict::Incident { reason, .. } => assert_eq!(reason, "size_regression"),
            _ => panic!("ожидался инцидент"),
        }

        // Тот же размер, но другая история (форк).
        let mut forked = journal(3);
        forked[3] = LedgerEntry {
            seq: 3,
            at: forked[3].at,
            prev_hash: forked[2].entry_hash(),
            body: EntryBody::AccountOpened {
                account: AccountId([0xEE; 16]),
                owner_key: public_key(&[0xEE; 32]),
            },
        };
        let fork_head = head_of(&forked);
        let state = state_for(&big);
        match evaluate_head(Some(&state), &fork_head, None) {
            Verdict::Incident { reason, .. } => assert_eq!(reason, "same_size_different_head"),
            _ => panic!("ожидался инцидент"),
        }
    }

    #[test]
    fn forged_consistency_proof_is_incident() {
        let all = journal(3);
        let old = head_of(&all[..2]);
        let new = head_of(&all);
        let state = state_for(&old);
        let mut consistency = consistency_for(&all, old.size, new.size);
        // Подменяем один хеш доказательства.
        if let Some(first) = consistency.proof.first_mut() {
            *first = to_hex(&[0xAB; 32]);
        }
        match evaluate_head(Some(&state), &new, Some(&consistency)) {
            Verdict::Incident { reason, .. } => assert_eq!(reason, "consistency_failed"),
            _ => panic!("ожидался инцидент"),
        }
    }

    #[test]
    fn replay_mismatch_is_incident() {
        let all = journal(2);
        let mut wrong = head_of(&all);
        wrong.merkle_root = [0xCD; 32];
        match evaluate_replay(&all, &wrong) {
            Verdict::Incident { reason, .. } => assert_eq!(reason, "replay_head_mismatch"),
            _ => panic!("ожидался инцидент"),
        }
        assert!(matches!(
            evaluate_replay(&all, &head_of(&all)),
            Verdict::Advance
        ));
    }

    #[test]
    fn state_file_roundtrip() {
        let entries = journal(1);
        let state = state_for(&head_of(&entries));
        let dir = std::env::temp_dir().join(format!("few-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        save_state(&path, &state).unwrap();
        let loaded = load_state(&path).unwrap().expect("state существует");
        assert_eq!(loaded.head, state.head);
        assert_eq!(loaded.signature_hex, state.signature_hex);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn seed_file_roundtrip_and_keygen_shape() {
        let dir = std::env::temp_dir().join(format!("few-seed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("seed.hex");
        let seed = [0x42u8; 32];
        write_seed(&path, &seed, false).unwrap();
        assert!(
            write_seed(&path, &seed, false).is_err(),
            "без --force не перезаписываем"
        );
        assert_eq!(read_seed(&path).unwrap(), seed);
        std::fs::remove_dir_all(&dir).ok();
    }
}
