using Flora.Auth.Contracts;
using Flora.Auth.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Auth.Infrastructure;

public sealed class AccountReadQueries(AuthDbContext db) : IAccountReadQueries
{
    public async Task<AccountRow?> FindActiveByPhoneAsync(string phone, CancellationToken cancellationToken = default)
    {
        var u = await db.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Phone == phone && x.Status == UserAccountStatus.Active, cancellationToken);
        return u == null ? null : Map(u);
    }

    public async Task<AccountRow?> FindByUuidAsync(Guid userUuid, CancellationToken cancellationToken = default)
    {
        var u = await db.UserAccounts.AsNoTracking().FirstOrDefaultAsync(x => x.UserUuid == userUuid, cancellationToken);
        return u == null ? null : Map(u);
    }

    public async Task<AccountRow?> FindByUsernameAsync(string username, CancellationToken cancellationToken = default)
    {
        var u = await db.UserAccounts.AsNoTracking().FirstOrDefaultAsync(x => x.Username == username, cancellationToken);
        return u == null ? null : Map(u);
    }

    public Task<bool> AnyPhoneAsync(string phone, CancellationToken cancellationToken = default) =>
        db.UserAccounts.AnyAsync(x => x.Phone == phone, cancellationToken);

    public Task<bool> ExistsAsync(Guid userUuid, CancellationToken cancellationToken = default) =>
        db.UserAccounts.AsNoTracking().AnyAsync(x => x.UserUuid == userUuid, cancellationToken);

    public async Task<IReadOnlyList<AccountRow>> GetByUuidsAsync(IReadOnlyCollection<Guid> userUuids, CancellationToken cancellationToken = default)
    {
        if (userUuids.Count == 0) return Array.Empty<AccountRow>();
        var list = await db.UserAccounts.AsNoTracking()
            .Where(x => userUuids.Contains(x.UserUuid))
            .ToListAsync(cancellationToken);
        return list.Select(Map).ToList();
    }

    public Task<bool> UsernameTakenAsync(Guid excludeUserUuid, string username, CancellationToken cancellationToken = default) =>
        db.UserAccounts.AnyAsync(x => x.UserUuid != excludeUserUuid && x.Username == username, cancellationToken);

    public async Task<IReadOnlyList<AccountRow>> SearchAccountsAsync(
        Guid excludeUserUuid,
        string queryLower,
        int skip,
        int take,
        CancellationToken cancellationToken = default)
    {
        var q = queryLower.Trim();
        if (q.Length == 0) return Array.Empty<AccountRow>();
        var list = await db.UserAccounts.AsNoTracking()
            .Where(a => a.UserUuid != excludeUserUuid && a.Username != null && a.Username.ToLower().Contains(q))
            .OrderBy(a => a.Username)
            .Skip(skip).Take(take)
            .ToListAsync(cancellationToken);
        return list.Select(Map).ToList();
    }

    private static AccountRow Map(UserAccount u) => new(
        u.UserUuid,
        u.Username,
        u.Phone,
        u.Email,
        (int)u.Status,
        u.CreatedAt,
        u.UpdatedAt);
}
