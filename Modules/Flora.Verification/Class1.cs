using Microsoft.Extensions.DependencyInjection;

namespace Flora.Verification;

public static class VerificationModuleComposition
{
    public static IServiceCollection AddVerificationModule(this IServiceCollection services)
    {
        return services;
    }
}
