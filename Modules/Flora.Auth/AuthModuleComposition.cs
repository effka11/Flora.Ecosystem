using Flora.Auth.Application;
using Flora.Auth.Contracts;
using Flora.Auth.Infrastructure;
using Flora.Auth.Infrastructure.Grpc;
using Flora.Auth.Infrastructure.Options;
using Flora.Auth.Infrastructure.Services;
using Flora.Shared.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Auth;

public static class AuthModuleComposition
{
    public static IServiceCollection AddAuthModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.Configure<JwtOptions>(configuration.GetSection(JwtOptions.SectionName));
        services.AddDbContext<AuthDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(AuthDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Auth", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        services.AddScoped<IPasswordHasher, Argon2PasswordHasher>();
        services.AddScoped<ITokenService, JwtTokenService>();
        services.AddScoped<IAccountReadQueries, AccountReadQueries>();
        services.AddScoped<IAuthEmailRegistrationOrchestrator, AuthEmailRegistrationOrchestrator>();
        services.AddScoped<IAuthCredentialOperations, AuthCredentialOperations>();
        services.AddScoped<IAuthAccountSecurityService, AuthAccountSecurityService>();
        services.AddGrpc();
        services.AddScoped<AuthGrpcService>();

        return services;
    }

    public static IEndpointRouteBuilder MapAuthModuleGrpc(this IEndpointRouteBuilder endpoints)
    {
        // The gRPC AuthService duplicates the authenticated HTTP API and is unconsumed by the
        // shipped clients. Keep it disabled by default so it is not a public unauthenticated
        // surface; enable explicitly (e.g. on an internal-only endpoint) via configuration.
        var configuration = endpoints.ServiceProvider.GetRequiredService<IConfiguration>();
        var enabled = string.Equals(configuration["Grpc:AuthService:Enabled"], "true", StringComparison.OrdinalIgnoreCase);
        if (enabled)
            endpoints.MapGrpcService<AuthGrpcService>();
        return endpoints;
    }
}
