//! Documentation gate: the §12 table, the conformance map and the decision log
//! must describe the same set of checks.
//!
//! The test reads the product documents and the Rust sources as text. It does
//! not compile or run the referenced tests; `cargo test` already does that.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const SPEC: &str = "../../docs/fgce.md";
const QUESTIONS: &str = "../../docs/questions.md";
const README: &str = "readme.md";

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

/// Test functions per file: `file.rs -> {name}`. Both the conformance package
/// and the kernel sources are scanned, so `unit` rows resolve too.
fn collect_tests(root: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let mut tests = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let Some(file) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let source = match std::fs::read_to_string(&path) {
                Ok(source) => source,
                Err(_) => continue,
            };
            let mut pending = false;
            for line in source.lines() {
                let trimmed = line.trim();
                if trimmed == "#[test]" {
                    pending = true;
                    continue;
                }
                if pending && trimmed.starts_with("fn ") {
                    let name = trimmed
                        .trim_start_matches("fn ")
                        .split('(')
                        .next()
                        .unwrap_or("")
                        .trim();
                    tests
                        .entry(file.to_string())
                        .or_insert_with(BTreeSet::new)
                        .insert(name.to_string());
                    pending = false;
                }
            }
        }
    }
    tests
}

fn section<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("missing section {start}"));
    let rest = &text[from + start.len()..];
    match rest.find(end) {
        Some(at) => &rest[..at],
        None => rest,
    }
}

/// Data rows of the §12 table, in order. The first row is `VERSION`.
fn spec_rows() -> Vec<String> {
    let spec = read(SPEC);
    let table = section(&spec, "## 12. Нормативные проверки", "## 13.");
    let mut rows = Vec::new();
    for line in table.lines() {
        if !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line
            .trim()
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect();
        if cells.len() < 2 || cells[0] == "Проверка" {
            continue;
        }
        if cells[0].chars().all(|c| c == '-' || c == ' ') {
            continue;
        }
        rows.push(cells[0].to_string());
    }
    rows
}

fn parse_row_spec(text: &str) -> Vec<usize> {
    let text = text.trim();
    let (start, end) = match text.split_once('–').or_else(|| text.split_once('-')) {
        Some((start, end)) => (start, end),
        None => (text, text),
    };
    let start: usize = start
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("bad §12 row spec: {text}"));
    let end: usize = end
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("bad §12 row spec: {text}"));
    (start..=end).collect()
}

fn refs(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find('`') {
        rest = &rest[at + 1..];
        let Some(end) = rest.find('`') else { break };
        let candidate = &rest[..end];
        rest = &rest[end + 1..];
        if candidate.contains(".rs::") {
            out.insert(candidate.to_string());
        }
    }
    out
}

struct MapEntry {
    rows: Vec<usize>,
    status: String,
    tests: BTreeSet<String>,
}

fn map_entries() -> Vec<MapEntry> {
    let readme = read(README);
    let table = section(&readme, "## Карта §12 → тест", "## Вспомогательные тесты");
    let mut entries = Vec::new();
    for line in table.lines() {
        if !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line
            .trim()
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect();
        if cells.len() < 3 || cells[0] == "§12" {
            continue;
        }
        if cells[0].chars().all(|c| c == '-' || c == ' ') {
            continue;
        }
        entries.push(MapEntry {
            rows: parse_row_spec(cells[0]),
            status: cells[1].to_string(),
            tests: refs(cells[2]),
        });
    }
    entries
}

fn auxiliary_refs() -> BTreeSet<String> {
    let readme = read(README);
    let text = section(&readme, "## Вспомогательные тесты", "## Аудит §11");
    refs(text)
}

fn known(tests: &BTreeMap<String, BTreeSet<String>>, reference: &str) -> bool {
    let Some((file, name)) = reference.split_once("::") else {
        return false;
    };
    tests.get(file).is_some_and(|names| names.contains(name))
}

#[test]
fn row_g11_every_spec_row_has_a_test_set() {
    let rows = spec_rows();
    let mut covered = BTreeSet::new();
    for entry in map_entries() {
        covered.extend(entry.rows);
    }
    let missing: Vec<usize> = (1..=rows.len())
        .filter(|row| !covered.contains(row))
        .collect();
    assert!(
        missing.is_empty(),
        "§12 rows without a test set: {missing:?} (table has {} rows)",
        rows.len()
    );
    let extra: Vec<usize> = covered
        .iter()
        .copied()
        .filter(|row| *row == 0 || *row > rows.len())
        .collect();
    assert!(extra.is_empty(), "map points outside §12: {extra:?}");
}

#[test]
fn row_g11_every_mapped_test_exists() {
    let mut tests = collect_tests(Path::new("tests"));
    let kernel = collect_tests(Path::new("../../crates/fgce/src"));
    for (file, names) in kernel {
        tests.entry(file).or_default().extend(names);
    }
    let mut missing = Vec::new();
    for entry in map_entries() {
        for reference in &entry.tests {
            if !known(&tests, reference) {
                missing.push(reference.clone());
            }
        }
    }
    assert!(missing.is_empty(), "mapped tests do not exist: {missing:?}");
}

#[test]
fn row_g11_every_test_is_mapped_or_whitelisted() {
    // Kernel unit tests observe internal values; only the conformance package
    // must be reachable from a §12 row or the auxiliary whitelist.
    let tests = collect_tests(Path::new("tests"));

    let mut mapped = BTreeSet::new();
    for entry in map_entries() {
        mapped.extend(entry.tests);
    }
    mapped.extend(auxiliary_refs());

    let mut orphans = Vec::new();
    for (file, names) in &tests {
        for name in names {
            let reference = format!("{file}::{name}");
            let is_gate = file == "meta_docs.rs";
            if !is_gate && !mapped.contains(&reference) {
                orphans.push(reference);
            }
        }
    }
    assert!(
        orphans.is_empty(),
        "tests without a §12 row or the auxiliary whitelist: {orphans:?}"
    );
}

#[test]
fn row_g11_decisions_d1_to_d19_are_recorded() {
    let questions = read(QUESTIONS);
    let missing: Vec<usize> = (1..=19)
        .filter(|id| !questions.contains(&format!("### D{id}.")))
        .collect();
    assert!(missing.is_empty(), "questions.md lacks D{missing:?}");
}

#[test]
fn row_g11_every_map_entry_lists_a_test() {
    for entry in map_entries() {
        // `typed` rows describe a field that the Rust contract cannot omit;
        // the type system is the check and there is no runtime test to name.
        if entry.status == "typed" {
            continue;
        }
        assert!(
            !entry.tests.is_empty(),
            "§12 rows {:?} have no test reference",
            entry.rows
        );
    }
}
