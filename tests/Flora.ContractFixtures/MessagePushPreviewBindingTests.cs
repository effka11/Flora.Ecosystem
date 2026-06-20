using System.Text.Json;
using Flora.Messaging.Contracts;
using Xunit;

namespace Flora.ContractFixtures;

public sealed class MessagePushPreviewBindingTests
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    [Fact]
    public void PostConversationMessageRequest_deserializes_pushPreview()
    {
        const string json = """
            {
              "encryptedForReceiver": "wire-a",
              "encryptedForSender": "wire-b",
              "pushPreview": "Привет, мир"
            }
            """;

        using var doc = JsonDocument.Parse(json);
        var request = doc.RootElement.Deserialize<PostConversationMessageRequest>(Json);
        Assert.NotNull(request);
        Assert.Equal("Привет, мир", request.PushPreview);
    }
}
