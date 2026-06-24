using Flora.Verification.Application;
using Flora.Verification.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Verification.Infrastructure;

public sealed class VerificationChallengeRepository(VerificationDbContext db) : IVerificationChallengeRepository
{
    public Task<VerificationChallenge?> FindByTokenAsync(Guid token, CancellationToken ct) =>
        db.VerificationChallenges.FirstOrDefaultAsync(c => c.Token == token, ct);

    public async Task AddAsync(VerificationChallenge challenge, CancellationToken ct)
    {
        db.VerificationChallenges.Add(challenge);
        await db.SaveChangesAsync(ct).ConfigureAwait(false);
    }

    public Task UpdateAsync(VerificationChallenge challenge, CancellationToken ct) =>
        db.SaveChangesAsync(ct);

    public async Task RemoveAsync(VerificationChallenge challenge, CancellationToken ct)
    {
        db.VerificationChallenges.Remove(challenge);
        await db.SaveChangesAsync(ct).ConfigureAwait(false);
    }

    public async Task RemoveExpiredAsync(DateTime utcNow, CancellationToken ct)
    {
        var expired = await db.VerificationChallenges
            .Where(c => c.ExpiresAt <= utcNow)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        if (expired.Count == 0) return;
        db.VerificationChallenges.RemoveRange(expired);
        await db.SaveChangesAsync(ct).ConfigureAwait(false);
    }
}
