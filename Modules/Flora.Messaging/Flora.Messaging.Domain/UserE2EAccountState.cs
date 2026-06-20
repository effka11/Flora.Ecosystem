namespace Flora.Messaging.Domain;

/// <summary>
/// E2E account state FSM values (docs/fscp/e2e-security.md §FSM).
/// The server tracks which state the user's E2E session is in.
/// </summary>
public enum E2EAccountStateKind
{
    NotInitialized,
    Active,
    Locked,
    ActiveNewEpoch,
    Recovering,
    Rotating,
    Frozen,
}

/// <summary>
/// Tracks the user's E2E account state (one row per user).
/// Maps to table <c>user_e2e_account_states</c>.
/// </summary>
public sealed class UserE2EAccountState
{
    public Guid UserUuid { get; set; }
    public E2EAccountStateKind State { get; set; } = E2EAccountStateKind.NotInitialized;
    public bool Freeze { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
