using System.Security.Cryptography;
using Flora.API;
using Flora.Notifications;
using Flora.Social;

var builder = WebApplication.CreateBuilder(args);

if (builder.Environment.IsDevelopment())
{
    // Dev-only overrides (never load on Production — would shadow Flora__AdminBroadcastToken etc.).
    builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);
}

// Never ship a static JWT secret. In Development, mint an ephemeral in-memory secret so a fresh
// clone runs out of the box (tokens reset on restart). appsettings.Local.json may copy example
// placeholders — treat those like "unset". All other environments fail-fast in AddFloraJwtBearer.
if (builder.Environment.IsDevelopment()
    && FloraJwtExtensions.ShouldMintEphemeralDevelopmentSecret(builder.Configuration["Jwt:Secret"]))
{
    builder.Configuration["Jwt:Secret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(48));
}

var corsOrigins = builder.Configuration.GetSection("FloraWeb:CorsOrigins").Get<string[]>() ?? [];
if (corsOrigins.Length > 0)
{
    builder.Services.AddCors(options =>
    {
        options.AddPolicy(
            "FloraWeb",
            policy => policy.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod().AllowCredentials());
    });
}

builder.Services.AddFloraSocialProduct(builder.Configuration);

var app = builder.Build();

// Detailed exception pages (stack traces, request details) are restricted to Development so a public
// deployment never leaks internals on a 500. Non-Development responses fall back to the default
// opaque error handling.
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}

if (corsOrigins.Length > 0)
    app.UseCors("FloraWeb");

app.UseMiddleware<FloraClientVersionMiddleware>();

app.UseAuthentication();
app.UseAuthorization();
app.UseNotificationsModule();

// Enforce the rate-limit policies declared by the Social product and Messaging module. Placed
// after authentication so user-partitioned policies can read the JWT subject claim.
app.UseRateLimiter();

app.MapGet("/", () => Results.Ok(new
{
    service = "Flora.API",
    status = "ready"
}));

app.MapGet("/health", () => Results.Ok(new
{
    status = "healthy"
}));

app.MapGet("/version", () => Results.Ok(FloraVersions.Current));

app.MapFloraSocialProduct();
app.Run();

public partial class Program;
