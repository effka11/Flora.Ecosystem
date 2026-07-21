"use client";

/**
 * Safety number 1:1 (Documents/fscp/FSCP.md §Safety number, compliance-пункт 6):
 * оба клиента при одинаковых входах обязаны увидеть одинаковые 64 hex-символа;
 * сверка — out-of-band (лично/по другому каналу). Расчёт — computeSafetyNumberV1
 * из `@flora/client-core/fscp` (SoT, golden fingerprint-v1.json).
 *
 * Identity-ключи v1 (bootstrap epoch): свой — из локального signing key,
 * ключ собеседника — TOFU из последнего успешно расшифрованного входящего wire
 * (`senderSigningPublicKeyBase64Url`); до первого входящего (сессия не `ready`)
 * показывается заглушка.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  computeSafetyNumberV1,
  formatSafetyNumberGroups,
} from "@flora/client-core/fscp";
import { fromBase64Flexible } from "@/lib/fscp/base64url";
import { FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "@/lib/fscp/constants";
import { dmConversationUuid } from "@/lib/fscp/deriveIds";
import styles from "./messages.module.css";

type MessagesSafetyNumberModalProps = {
  open: boolean;
  closing: boolean;
  peerDisplayName: string;
  viewerUserUuid: string;
  peerUserUuid: string;
  /** Локальный 64-байтовый libsodium signing private key (seed + public key). */
  selfSigningPrivateKey: Uint8Array | null;
  /** Ed25519 pk собеседника из последнего расшифрованного входящего; null — сессия ещё не ready. */
  peerIdentityPublicKeyBase64Url: string | null;
  onClose: () => void;
};

/** Публичная половина 64-байтового libsodium Ed25519 secret key. */
function selfIdentityPublicKey(signingPrivateKey: Uint8Array): Uint8Array {
  if (signingPrivateKey.byteLength !== 64) {
    throw new Error("Safety number: локальный Ed25519 secret key должен быть 64 байта.");
  }
  return signingPrivateKey.subarray(32, 64);
}

export function MessagesSafetyNumberModal({
  open,
  closing,
  peerDisplayName,
  viewerUserUuid,
  peerUserUuid,
  selfSigningPrivateKey,
  peerIdentityPublicKeyBase64Url,
  onClose,
}: MessagesSafetyNumberModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  const conversationUuid = useMemo(
    () => (viewerUserUuid && peerUserUuid ? dmConversationUuid(viewerUserUuid, peerUserUuid) : ""),
    [peerUserUuid, viewerUserUuid],
  );

  const close = useCallback(() => {
    setCopied(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open || closing) return;
    closeRef.current?.focus();
  }, [closing, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  const safetyNumber = useMemo((): { hex: string | null; error: string | null } => {
    if (!open || !selfSigningPrivateKey || !peerIdentityPublicKeyBase64Url || !conversationUuid) {
      return { hex: null, error: null };
    }
    try {
      const selfPk = selfIdentityPublicKey(selfSigningPrivateKey);
      const peerPk = fromBase64Flexible(peerIdentityPublicKeyBase64Url);
      return {
        hex: computeSafetyNumberV1({
          keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
          conversationUuid,
          identityPublicKeyA: selfPk,
          identityPublicKeyB: peerPk,
        }),
        error: null,
      };
    } catch (error) {
      return {
        hex: null,
        error: error instanceof Error ? error.message : "Не удалось вычислить safety number.",
      };
    }
  }, [conversationUuid, open, peerIdentityPublicKeyBase64Url, selfSigningPrivateKey]);

  if (!open) return null;

  const name = peerDisplayName.trim() || "собеседником";
  const notReady = !peerIdentityPublicKeyBase64Url;
  const noLocalKeys = !selfSigningPrivateKey;
  const hex = safetyNumber.hex;
  const groups = hex ? formatSafetyNumberGroups(hex) : null;

  return (
    <>
      <div
        className={`${styles.messagesDeleteModalBackdrop}${closing ? ` ${styles.messagesDeleteModalBackdropClosing}` : ""}`}
        onClick={close}
        aria-hidden
      />
      <div className={styles.messagesDeleteModal} role="presentation">
        <div
          className={`${styles.messagesDeleteModalDialog}${closing ? ` ${styles.messagesDeleteModalDialogClosing}` : ""}`}
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.messagesDeleteModalHeader}>
            <h2 id={titleId} className={styles.messagesDeleteModalTitle}>
              Проверка шифрования
            </h2>
            <button
              type="button"
              className={styles.messagesDeleteModalClose}
              onClick={close}
              ref={closeRef}
              aria-label="Закрыть"
            >
              &times;
            </button>
          </div>
          <div className={styles.messagesDeleteModalBody}>
            <p id={descriptionId} className={styles.messagesDeleteModalText}>
              Сравните этот код с {name} по другому каналу (лично или голосом). Совпадение
              подтверждает, что переписку шифруют именно ваши устройства и никто не подменил ключи.
            </p>
            {noLocalKeys ? (
              <p className={styles.messagesSafetyNumberHint}>
                E2E-ключи на этом устройстве ещё не разблокированы.
              </p>
            ) : notReady ? (
              <p className={styles.messagesSafetyNumberHint}>
                Код появится после первого расшифрованного сообщения от {name} — ключ собеседника
                ещё не получен.
              </p>
            ) : safetyNumber.error ? (
              <p className={styles.messagesDeleteModalError} role="alert">
                {safetyNumber.error}
              </p>
            ) : groups ? (
              <div className={styles.messagesSafetyNumberGrid} aria-label="Safety number">
                {groups.map((g, i) => (
                  <span key={i} className={styles.messagesSafetyNumberGroup}>
                    {g}
                  </span>
                ))}
              </div>
            ) : (
              <p className={styles.messagesSafetyNumberHint}>Вычисление…</p>
            )}
          </div>
          <div className={styles.messagesDeleteModalActions}>
            {hex ? (
              <button
                type="button"
                className={styles.messagesDeleteModalBtnCancel}
                onClick={() => {
                  const write = navigator.clipboard?.writeText(hex);
                  if (!write) return;
                  void write
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => setCopied(false));
                }}
                aria-live="polite"
              >
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            ) : null}
            <button type="button" className={styles.messagesDeleteModalBtnCancel} onClick={close}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
