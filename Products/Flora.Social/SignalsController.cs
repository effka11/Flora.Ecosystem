using System.Security.Claims;
using Flora.Notifications.Application;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Flora.Social;

[ApiController]
[Route("api/auth/signals")]
[Authorize]
public sealed class SignalsController(IUserRealtimeHub hub) : ControllerBase
{
  private const int HeartbeatSeconds = 25;

  [HttpGet("stream")]
  public async Task Stream(CancellationToken ct)
  {
    if (!TryGetCurrentUser(out var userUuid))
    {
      Response.StatusCode = StatusCodes.Status401Unauthorized;
      return;
    }

    Response.Headers.CacheControl = "no-cache";
    Response.Headers.Connection = "keep-alive";
    Response.ContentType = "text/event-stream";

    var (connectionId, frames) = hub.Subscribe(userUuid, ct);

    try
    {
      using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
      var heartbeatTask = RunHeartbeatAsync(Response, heartbeatCts.Token);

      await foreach (var frame in frames.WithCancellation(ct))
      {
        await Response.WriteAsync(frame, ct);
        await Response.Body.FlushAsync(ct);
      }

      heartbeatCts.Cancel();
      await heartbeatTask;
    }
    finally
    {
      hub.Unsubscribe(userUuid, connectionId);
    }
  }

  private static async Task RunHeartbeatAsync(HttpResponse response, CancellationToken ct)
  {
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(HeartbeatSeconds));
    try
    {
      while (await timer.WaitForNextTickAsync(ct))
      {
        await response.WriteAsync(": ping\n\n", ct);
        await response.Body.FlushAsync(ct);
      }
    }
    catch (OperationCanceledException)
    {
      /* stream closed */
    }
  }

  private bool TryGetCurrentUser(out Guid userUuid)
  {
    var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    if (!string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid))
      return true;
    userUuid = Guid.Empty;
    return false;
  }
}
