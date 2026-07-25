package expo.modules.florafrci

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private object FloraFrcINative {
  val loaded: Boolean = try {
    System.loadLibrary("frc_i_mobile_ffi")
    true
  } catch (_: UnsatisfiedLinkError) {
    false
  }

  external fun encodeFile(inputPath: String, outputPath: String, quality: Int): Int
  external fun decodeFile(inputPath: String, outputPath: String): Int
  external fun decodeFileScaled(inputPath: String, outputPath: String, maxDimension: Int, quality: Int): Int
  external fun readInfo(inputPath: String, out: IntArray): Int
}

class FloraFrcIModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FloraFrcI")

    Function("isAvailable") {
      FloraFrcINative.loaded
    }

    AsyncFunction("encodeFile") { inputPath: String, outputPath: String, quality: Int ->
      check(FloraFrcINative.loaded) { "FRC-I native library is unavailable" }
      val code = FloraFrcINative.encodeFile(normalizePath(inputPath), normalizePath(outputPath), quality)
      check(code == 0) { "FRC-I encode failed: $code" }
    }

    AsyncFunction("decodeFile") { inputPath: String, outputPath: String ->
      check(FloraFrcINative.loaded) { "FRC-I native library is unavailable" }
      val code = FloraFrcINative.decodeFile(normalizePath(inputPath), normalizePath(outputPath))
      check(code == 0) { "FRC-I decode failed: $code" }
    }

    AsyncFunction("decodeFileScaled") { inputPath: String, outputPath: String, maxDimension: Int, quality: Int ->
      check(FloraFrcINative.loaded) { "FRC-I native library is unavailable" }
      val code = FloraFrcINative.decodeFileScaled(
        normalizePath(inputPath),
        normalizePath(outputPath),
        maxDimension,
        quality,
      )
      check(code >= 0) { "FRC-I decodeFileScaled failed: $code" }
      if (code == 1) "png" else "jpeg"
    }

    AsyncFunction("readInfo") { inputPath: String ->
      check(FloraFrcINative.loaded) { "FRC-I native library is unavailable" }
      val out = IntArray(2)
      val code = FloraFrcINative.readInfo(normalizePath(inputPath), out)
      check(code == 0) { "FRC-I readInfo failed: $code" }
      mapOf("width" to out[0], "height" to out[1])
    }
  }

  private fun normalizePath(path: String): String =
    if (path.startsWith("file://")) android.net.Uri.parse(path).path ?: path else path
}
