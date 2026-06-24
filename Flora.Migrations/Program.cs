// Design-time startup for Entity Framework Core CLI.
// Runtime host is Flora.API; this project only supplies connection configuration
// via appsettings.json / environment variables and IDesignTimeDbContextFactory types.
//
// Apply order on an empty database: Auth → Verification → Users → Content → Messaging → Notifications → Music
// (FK dependencies). Verification owns no cross-module FKs, so its position is flexible; it is applied
// right after Auth to match the runtime composition order (Verification before Auth's consumers).
//
// PowerShell examples (run from repo root: Flora.Ecosystem):
//
//   $env:ConnectionStrings__FloraDatabase = "Host=localhost;Database=flora_core;Username=postgres;Password=***"
//
//   dotnet ef migrations add Initial --project Modules/Flora.Auth/Flora.Auth.Infrastructure/Flora.Auth.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context AuthDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Auth/Flora.Auth.Infrastructure/Flora.Auth.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context AuthDbContext
//
//   dotnet ef migrations add Initial --project Modules/Flora.Users/Flora.Users.Infrastructure/Flora.Users.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context UsersDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Users/Flora.Users.Infrastructure/Flora.Users.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context UsersDbContext
//
//   dotnet ef migrations add Initial --project Modules/Flora.Content/Flora.Content.Infrastructure/Flora.Content.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context ContentDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Content/Flora.Content.Infrastructure/Flora.Content.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context ContentDbContext
//
//   dotnet ef migrations add Initial --project Modules/Flora.Messaging/Flora.Messaging.Infrastructure/Flora.Messaging.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context MessagingDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Messaging/Flora.Messaging.Infrastructure/Flora.Messaging.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context MessagingDbContext
//
//   dotnet ef migrations add Initial --project Modules/Flora.Notifications/Flora.Notifications.Infrastructure/Flora.Notifications.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context NotificationsDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Notifications/Flora.Notifications.Infrastructure/Flora.Notifications.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context NotificationsDbContext
//
//   dotnet ef migrations add InitialVerification --project Modules/Flora.Verification/Flora.Verification.Infrastructure/Flora.Verification.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context VerificationDbContext --output-dir Data/Migrations
//   dotnet ef database update --project Modules/Flora.Verification/Flora.Verification.Infrastructure/Flora.Verification.Infrastructure.csproj --startup-project Flora.Migrations/Flora.Migrations.csproj --context VerificationDbContext
//
// Existing database created from flora_social_schema.sql: generate Initial migrations, then insert rows into
// flora_core."__EFMigrationsHistory_Auth" (etc.) instead of applying SQL — see Scripts/mark-initial-migrations-applied.sql.

Console.WriteLine("Flora.Migrations is an EF Core startup project; use `dotnet ef` with --startup-project Flora.Migrations.");

