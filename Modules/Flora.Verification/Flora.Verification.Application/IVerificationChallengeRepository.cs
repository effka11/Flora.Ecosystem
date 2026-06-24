using Flora.Verification.Domain;

namespace Flora.Verification.Application;

/// <summary>Persistence port for challenges. Implemented by Infrastructure over the Verification DbContext.</summary>
public interface IVerificationChallengeRepository
{
    Task<VerificationChallenge?> FindByTokenAsync(Guid token, CancellationToken ct);
    Task AddAsync(VerificationChallenge challenge, CancellationToken ct);
    Task UpdateAsync(VerificationChallenge challenge, CancellationToken ct);
    Task RemoveAsync(VerificationChallenge challenge, CancellationToken ct);
    Task RemoveExpiredAsync(DateTime utcNow, CancellationToken ct);
}
