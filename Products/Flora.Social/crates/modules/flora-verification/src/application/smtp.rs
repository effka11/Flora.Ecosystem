//! SMTP — паритет с SmtpVerificationCodeSender (C#).

use flora_shared::config::FloraConfig;
use lettre::message::{Mailbox, MessageBuilder};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tracing::{info, warn};

const SUBJECT: &str = "Flora ID: код подтверждения";

#[derive(Debug, Clone)]
pub struct SmtpOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from_email: String,
    pub from_name: String,
    pub enable_ssl: bool,
}

impl SmtpOptions {
    pub fn from_config(cfg: &FloraConfig) -> Self {
        Self {
            host: cfg.get("Smtp:Host").unwrap_or("").to_string(),
            port: cfg
                .get("Smtp:Port")
                .and_then(|s| s.parse().ok())
                .filter(|p| *p > 0)
                .unwrap_or(587),
            username: cfg.get("Smtp:Username").unwrap_or("").to_string(),
            password: cfg.get("Smtp:Password").unwrap_or("").to_string(),
            from_email: cfg.get("Smtp:FromEmail").unwrap_or("").to_string(),
            from_name: cfg
                .get_non_empty("Smtp:FromName")
                .unwrap_or("Flora")
                .to_string(),
            enable_ssl: cfg.get_bool("Smtp:EnableSsl").unwrap_or(true),
        }
    }

    fn configured(&self) -> bool {
        !self.host.trim().is_empty() && !self.from_email.trim().is_empty()
    }
}

#[derive(Debug)]
pub enum SendError {
    NotConfiguredProduction,
    Smtp(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfiguredProduction => write!(
                f,
                "SMTP is not configured for production. Set Smtp__Host, Smtp__FromEmail and credentials in flora-api.env."
            ),
            Self::Smtp(s) => write!(f, "{s}"),
        }
    }
}

pub struct SmtpVerificationCodeSender {
    options: SmtpOptions,
    development: bool,
}

impl SmtpVerificationCodeSender {
    pub fn new(options: SmtpOptions, development: bool) -> Self {
        Self {
            options,
            development,
        }
    }

    pub async fn send_email_verification_code(
        &self,
        email: &str,
        code: &str,
    ) -> Result<(), SendError> {
        if !self.options.configured() {
            if !self.development {
                return Err(SendError::NotConfiguredProduction);
            }
            info!(
                email,
                code,
                "SMTP is not configured — email not sent. Verification code logged for Development."
            );
            return Ok(());
        }

        let body = format!(
            "Ваш код подтверждения: {code}\n\nКод действует 15 минут и сбрасывается при выходе из окна регистрации."
        );

        let from: Mailbox = format!("{} <{}>", self.options.from_name, self.options.from_email)
            .parse()
            .map_err(|e| SendError::Smtp(format!("from: {e}")))?;
        let to: Mailbox = email
            .parse()
            .map_err(|e| SendError::Smtp(format!("to: {e}")))?;

        let message = MessageBuilder::new()
            .from(from)
            .to(to)
            .subject(SUBJECT)
            .body(body)
            .map_err(|e| SendError::Smtp(e.to_string()))?;

        self.dispatch(message).await
    }

    async fn dispatch(&self, message: Message) -> Result<(), SendError> {
        let builder = if self.options.enable_ssl {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.options.host)
                .map_err(|e| SendError::Smtp(e.to_string()))?
                .port(self.options.port)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.options.host)
                .port(self.options.port)
        };

        let mailer = if !self.options.username.trim().is_empty() {
            builder
                .credentials(Credentials::new(
                    self.options.username.clone(),
                    self.options.password.clone(),
                ))
                .build()
        } else {
            builder.build()
        };

        mailer.send(message).await.map_err(|e| {
            warn!(error = %e, "SMTP send failed");
            SendError::Smtp(e.to_string())
        })?;
        Ok(())
    }
}
