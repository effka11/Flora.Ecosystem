import * as Sentry from "@sentry/react-native";
import { configureTelemetry } from "@flora/client-core/telemetry";

let initialized = false;

export function initSentry(): void {
  if (initialized || !process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  initialized = true;
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.2,
    enableNative: true,
  });
}

export function initTelemetry(): void {
  configureTelemetry({
    capture(event) {
      if (__DEV__) console.debug("[telemetry]", event);
      Sentry.addBreadcrumb({ category: "flora", message: event.type, data: event as Record<string, unknown> });
    },
    captureException(err, context) {
      if (__DEV__) console.error("[telemetry]", err, context);
      Sentry.captureException(err, { extra: context });
    },
  });
}
