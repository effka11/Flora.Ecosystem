using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Flora.Social;

/// <summary>Конвертация загруженных фото поста в WebP: ресайз, стриппинг метаданных, сжатие (без внешних avifenc).</summary>
internal static class PostImageProcessor
{
    private const int MaxDimension = 2048;
    private const int WebpQuality = 82;

    /// <summary>
    /// Pixel budget guarding against decompression bombs — a tiny file that decodes into a huge
    /// bitmap and exhausts memory. ~50 MP comfortably covers legitimate phone/camera photos.
    /// </summary>
    private const long MaxPixels = 50_000_000;

    private static readonly WebpEncoder Encoder = new()
    {
        Quality = WebpQuality,
        FileFormat = WebpFileFormatType.Lossy,
    };

    /// <summary>
    /// Validates and re-encodes an uploaded image to WebP. Decoding doubles as content validation
    /// (non-images throw), and re-encoding strips any embedded payload/metadata. Throws
    /// <see cref="InvalidOperationException"/> if the declared pixel dimensions exceed the budget.
    /// </summary>
    public static async Task<(byte[] Data, string ContentType)> ProcessAsync(Stream input, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await input.CopyToAsync(buffer, ct);
        buffer.Position = 0;

        var info = await Image.IdentifyAsync(buffer, ct);
        if ((long)info.Width * info.Height > MaxPixels)
            throw new InvalidOperationException("Изображение слишком большое (превышен лимит пикселей).");
        buffer.Position = 0;

        using var image = await Image.LoadAsync(buffer, ct);

        if (image.Width > MaxDimension || image.Height > MaxDimension)
        {
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Mode = ResizeMode.Max,
                Size = new Size(MaxDimension, MaxDimension),
                Sampler = KnownResamplers.Lanczos3,
            }));
        }

        image.Metadata.ExifProfile = null;
        image.Metadata.IptcProfile = null;
        image.Metadata.XmpProfile = null;

        using var ms = new MemoryStream();
        await image.SaveAsync(ms, Encoder, ct);
        return (ms.ToArray(), "image/webp");
    }
}
