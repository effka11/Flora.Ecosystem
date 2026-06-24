using Flora.Shared.Persistence;
using Flora.Verification.Application;
using Flora.Verification.Contracts;
using Flora.Verification.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Verification;

public static class VerificationModuleComposition
{
    public static IServiceCollection AddVerificationModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.Configure<SmtpOptions>(configuration.GetSection(SmtpOptions.SectionName));

        services.AddDbContext<VerificationDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(VerificationDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Verification", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        services.AddScoped<IVerificationChallengeRepository, VerificationChallengeRepository>();
        services.AddScoped<IVerificationCodeSender, SmtpVerificationCodeSender>();
        services.AddScoped<IVerificationChallengeService, VerificationChallengeService>();

        return services;
    }
}
