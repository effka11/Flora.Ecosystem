using Flora.Shared;

namespace Flora.Content.Domain;

/// <summary>
/// Зарезервированные ссылки сообществ (<c>/communities/&lt;slug&gt;</c>).
/// Нельзя занимать при создании и смене slug — защита маршрутов, имперсонации и злоупотреблений.
/// </summary>
public static class CommunityReservedSlugs
{
    private static readonly HashSet<string> Exact = new(StringComparer.Ordinal)
    {
        // Маршруты Flora и служебные сегменты
        "own", "new", "create", "edit", "delete", "settings", "feed", "messages", "people",
        "communities", "community", "music", "notifications", "profile", "compose", "login",
        "logout", "signin", "sign-in", "signup", "sign-up", "register", "auth", "oauth",
        "callback", "webhook", "api", "admin", "administrator", "administration", "moderation",
        "moderator", "moderators", "mod", "mods", "staff", "team", "internal", "system", "root",
        "null", "undefined", "true", "false", "me", "self", "user", "users", "public", "private",
        "search", "explore", "discover", "trending", "recommended", "recommendations",
        "subscriptions", "following", "followers", "archive", "archived", "draft", "drafts",
        "post", "posts", "comment", "comments", "message", "channel", "channels", "group",
        "groups", "event", "events", "notification", "help", "support", "about", "contact",
        "terms", "privacy", "policy", "legal", "security", "trust", "safety", "report", "abuse",
        "copyright", "dmca", "status", "health", "ping", "metrics", "debug", "test", "testing",
        "demo", "staging", "production", "prod", "dev", "development", "beta", "alpha",
        "preview", "release", "updates", "blog", "news", "press", "media", "careers", "jobs",
        "billing", "payment", "payments", "invoice", "checkout", "subscribe", "unsubscribe",
        "verify", "verification", "confirm", "confirmation", "reset", "restore", "recover",
        "recovery", "account", "accounts", "password", "passwd", "email", "mail", "inbox",
        "sent", "trash", "spam", "flora", "floras", "flora-s", "flora-net", "flora-official",
        "flora-team", "flora-support", "flora-admin", "flora-security", "official", "verified",
        "bluecheck", "partner", "partners", "ambassador", "brand", "brands", "trademark",
        "www", "app", "web", "mobile", "desktop", "static", "assets", "cdn", "files", "upload",
        "uploads", "download", "downloads", "share", "invite", "invites", "join", "leave",
        "ban", "banned", "suspend", "suspended", "delete-account", "deactivate",

        // Имперсонация поддержки / администрации
        "support-team", "help-center", "helpdesk", "customer-support", "tech-support",
        "security-team", "trust-and-safety", "abuse-team", "report-abuse", "admin-panel",
        "admin-console", "dashboard-admin", "moderator-team", "official-community",
        "official-page", "verified-community", "customer-service", "service-desk",

        // Фишинг, мошенничество, взлом
        "phishing", "scam", "scams", "fraud", "carding", "darknet", "dark-web", "darkmarket",
        "malware", "ransomware", "exploit", "botnet", "hacker", "hackers", "hacking", "hack",
        "crack", "cracks", "keygen", "warez", "illegal", "contraband", "carder", "carders",
        "stealer", "stealers", "phish", "spoof", "spoofing", "identity-theft", "social-engineering",

        // Наркотики, оружие, терроризм, эксплуатация
        "drugs", "narcotics", "cocaine", "heroin", "meth", "fentanyl", "weapon", "weapons",
        "firearms", "gun", "guns", "ammunition", "terrorism", "terrorist", "terrorists",
        "extremism", "extremist", "isis", "isil", "nazism", "nazi", "hitler", "child-abuse",
        "csam", "pedophile", "pedophilia", "trafficking", "human-trafficking",
        "money-laundering", "sanctions", "sanctioned", "organized-crime", "mafia",

        // Порнография / секс-услуги (злоупотребления)
        "porn", "pornhub", "xxx", "sex-trade", "escort-service", "prostitution",

        // Бренды и платформы (ввод в заблуждение)
        "meta", "instagram", "telegram", "whatsapp", "vk", "vkontakte", "youtube", "tiktok",
        "twitter", "x-com", "facebook", "google", "apple", "microsoft", "amazon", "netflix",
        "spotify", "paypal", "visa", "mastercard", "stripe", "coinbase", "binance",

        // Госорганы и финсектор РФ (имперсонация)
        "gosuslugi", "gosuslugi-official", "nalog", "fns", "mvd", "fsb", "rosgvardia",
        "kremlin", "government", "gov-ru", "govru", "minjust", "roskomnadzor", "cbr",
        "central-bank", "sberbank", "sberbank-official", "tinkoff", "tinkoff-official",
        "vtb", "vtb-official", "alfabank", "raiffeisen", "rosbank",
        "fbi", "cia", "nsa", "dhs", "dod", "dea", "atf", "ice", "cbp", "tsa", "uscis",
        "irs", "treasury", "us-treasury", "state-department", "whitehouse", "white-house",
        "congress", "senate", "house", "usgov", "us-gov", "gov-us", "usa-gov", "usa",
        "police", "sheriff", "marshals", "us-marshals", "secret-service", "homeland-security",
        "department-of-justice", "justice-department", "doj", "sec", "ftc", "fcc", "cisa",
        "fema", "cdc", "fda", "nih", "usps", "federalreserve", "federal-reserve", "fed",
        "mi5", "mi6", "sis", "gchq", "met-police", "scotland-yard", "gov-uk", "govuk",
        "nhs", "hmrc", "ofcom", "fca", "bank-of-england", "parliament", "royal-family",
        "interpol", "europol", "nato", "un", "uno", "united-nations", "who", "wto", "imf",
        "worldbank", "world-bank", "eu", "european-union", "european-commission", "europa",
        "ecb", "eurojust", "frontex", "europarl", "bundesregierung", "bundestag", "bka",
        "bnd", "bfv", "polizei", "gendarmerie", "dgsi", "dgse", "elysee", "nationale",
        "carabinieri", "polizia", "guardia-di-finanza", "mossad", "shin-bet", "idf",
        "policia", "guardia-civil", "cnp", "cni", "rcmp", "csis", "asf", "asio", "asisa",
        "afp", "nzpolice", "npa", "psia", "kisa", "nso", "isro", "rbi", "sebi", "mas",
        "hkma", "sfc", "pboc", "safe", "csirc", "cert", "cert-eu", "certus",
        "home", "index", "main", "dashboard", "workspace", "workspaces", "timeline", "activity",
        "activities", "popular", "top", "latest", "recent", "all", "global", "local", "locales",
        "locale", "language", "languages", "i18n", "cdn-cgi", "robots", "sitemap", "manifest",
        "favicon", "assets-public", "public-assets", "static-assets", "media-assets",
        "storage", "bucket", "buckets", "blob", "blobs", "object", "objects", "image", "images",
        "photo", "photos", "video", "videos", "audio", "audios", "file", "attachment",
        "attachments", "export", "exports", "import", "imports", "backup", "backups",
        "restore-account", "session", "sessions", "token", "tokens", "jwt", "cookie", "cookies",
        "csrf", "xsrf", "sso", "saml", "openid", "oidc", "totp", "mfa", "2fa", "passkey",
        "passkeys", "webauthn", "credential", "credentials", "secret", "secrets", "key", "keys",
        "apikey", "api-key", "api-keys", "client", "clients", "client-id", "client-secret",
        "service", "services", "service-account", "service-accounts", "bot", "bots", "robot",
        "robots-txt", "crawler", "crawlers", "spider", "spiders", "agent", "agents", "daemon",
        "noreply", "no-reply", "donotreply", "do-not-reply", "mailer", "postmaster", "hostmaster",
        "webmaster", "sysadmin", "operator", "ops", "devops", "sre", "infra", "infrastructure",
        "network", "networks", "dns", "domain", "domains", "host", "hosts", "hosting", "server",
        "servers", "proxy", "proxies", "gateway", "gateways", "router", "routers", "cache",
        "queue", "queues", "worker", "workers", "job", "jobs-queue", "cron", "scheduler",
        "database", "databases", "db", "sql", "postgres", "postgresql", "mysql", "redis",
        "elastic", "elasticsearch", "kafka", "rabbitmq", "grpc", "rest", "graphql", "socket",
        "websocket", "ws", "rss", "atom", "xml", "json", "yaml", "yml", "well-known",
        "wellknown", "acme", "acme-challenge", "letsencrypt", "ssl", "tls", "cert", "certs",
        "certificate", "certificates", "mailing", "newsletter", "newsletters", "digest",
        "notification-center", "alerts", "alert", "incident", "incidents", "uptime",
        "monitoring", "monitor", "observability", "logs", "log", "audit", "audits", "analytics",
        "telemetry", "trace", "traces", "rate-limit", "rate-limits", "limits", "quota", "quotas",
        "flag", "flags", "feature", "features", "feature-flags", "experiment", "experiments",
        "labs", "lab", "sandbox", "canary", "nightly", "edge", "stable", "rc",
        "owner", "owners", "founder", "founders", "cofounder", "cofounders", "ceo", "cto",
        "cfo", "coo", "lead", "manager", "maintainer", "maintainers", "developer", "developers",
        "engineer", "engineers", "employee", "employees", "contractor", "contractors",
        "volunteer", "volunteers", "vip", "vips", "premium", "pro", "plus", "enterprise",
        "business", "commercial", "sales", "marketing", "ads", "ad", "advertising", "promo",
        "promotion", "promotions", "sponsor", "sponsors", "sponsored", "affiliate",
        "affiliates", "creator", "creators", "studio", "studios", "agency", "agencies",
        "press-team", "media-team", "brand-safety", "brand-protection", "legal-team",
        "privacy-team", "security-center", "trust-center", "safety-center", "moderation-team",
        "compliance", "compliance-team", "appeal", "appeals", "ticket", "tickets", "case",
        "cases", "complaint", "complaints", "feedback", "contact-us", "helpdesk-team",
        "support-center", "customer-success", "success-team", "account-manager",
        "billing-support", "payment-support", "refund", "refunds", "chargeback", "chargebacks",
        "tax", "taxes", "vat", "receipt", "receipts", "pricing", "plans", "plan", "license",
        "licenses", "subscription", "subscriptions-manage", "mailbox", "mailboxes", "calendar",
        "calendars", "drive", "browser", "browsers", "wallet", "wallets", "pay", "flora-pay",
        "flora-mail", "flora-browser", "flora-drive", "flora-music", "flora-social",
        "flora-id", "flora-account", "flora-accounts", "flora-service", "flora-services",
        "floranet", "floraapp", "floraweb", "flora-user", "flora-users", "flora-dev",
        "flora-beta", "flora-news", "flora-blog", "flora-status", "flora-help", "flora-legal",
        "flora-privacy", "flora-terms", "flora-trust", "flora-safety", "flora-moderation",
        "apple-support", "google-support", "meta-support", "facebook-support", "telegram-support",
        "youtube-support", "tiktok-support", "x-support", "twitter-support", "microsoft-support",
        "amazon-support", "paypal-support", "stripe-support", "binance-support", "coinbase-support",
        "bank", "banks", "banking", "finance", "financial", "fintech", "crypto", "bitcoin",
        "btc", "ethereum", "eth", "ton", "usdt", "usdc", "nft", "nfts", "airdrop", "airdrops",
        "giveaway", "giveaways", "lottery", "lotteries", "casino", "gambling", "bet", "bets",
        "betting", "bookmaker", "bookmakers", "loan", "loans", "credit", "credits", "debt",
        "blackmail", "extortion", "dox", "doxx", "doxxing", "swat", "swatting", "ddos", "spam-bot",
        "spam-bots", "fake", "fakes", "impersonation", "impersonator", "verification-team",
        "verify-team", "blue-badge", "badge", "badges", "checkmark", "checkmarks",
        "adult", "nsfw", "nude", "nudes", "onlyfans", "camgirl", "camgirls", "escort", "escorts",
        "suicide", "self-harm", "violence", "violent", "kill", "murder", "assassin", "assassins",
        "bomb", "bombs", "explosive", "explosives", "jihad", "jihadist", "kkk", "white-power",
        "slave", "slavery", "abduction", "kidnap", "kidnapping", "rape", "rapist",
    };

    private static readonly string[] ReservedPrefixes =
    [
      "admin",
      "administrator",
      "support",
      "helpdesk",
      "official",
      "verified",
      "moderator",
      "mod-team",
      "flora-official",
      "flora-team",
      "flora-support",
      "flora-admin",
      "flora-security",
      "security-team",
      "trust-and-safety",
      "abuse-team",
      "report-abuse",
      "staff",
      "team",
      "internal",
      "system",
      "root",
      "service-",
      "bot-",
      "noreply",
      "no-reply",
      "mailer",
      "postmaster",
      "hostmaster",
      "webmaster",
      "sysadmin",
      "operator",
      "devops",
      "infra",
      "security-",
      "trust-",
      "safety-",
      "moderation-",
      "billing-",
      "payment-",
      "legal-",
      "privacy-",
      "compliance-",
      "flora-",
      "floranet",
      "floraapp",
      "floraweb",
      "verify-",
      "verification-",
      "gosuslugi-",
      "sberbank-",
      "tinkoff-",
      "vtb-",
      "alfabank-",
      "fbi",
      "cia",
      "nsa",
      "dhs",
      "dod",
      "dea",
      "atf",
      "ice",
      "cbp",
      "tsa",
      "irs",
      "treasury",
      "police",
      "sheriff",
      "interpol",
      "europol",
      "nato",
      "un",
      "who",
      "mi5",
      "mi6",
      "gchq",
      "mossad",
      "policia",
      "polizei",
      "gendarmerie",
      "gov-",
      "paypal-",
      "stripe-",
      "binance-",
      "coinbase-",
      "bank",
      "crypto",
  ];

    /// <summary>Нормализованный slug уже в нижнем регистре (как после <see cref="NormalizeForCompare"/>).</summary>
    public static bool IsReserved(string normalizedSlug)
    {
        if (string.IsNullOrEmpty(normalizedSlug))
            return true;

        if (Exact.Contains(normalizedSlug))
            return true;

        var collapsed = CollapseSeparators(normalizedSlug);
        if (collapsed != normalizedSlug && Exact.Contains(collapsed))
            return true;

        foreach (var prefix in ReservedPrefixes)
        {
            if (normalizedSlug.StartsWith(prefix, StringComparison.Ordinal))
                return true;
        }

        return false;
    }

    /// <summary>Схлопывает дефисы и подчёркивания — против обхода вроде <c>ad-min</c>.</summary>
    public static string CollapseSeparators(string slug) =>
        slug.Replace("-", "", StringComparison.Ordinal).Replace("_", "", StringComparison.Ordinal);

    public static string NormalizeForCompare(string? raw) =>
        LatinIdentifiers.NormalizeSlug(raw);
}
