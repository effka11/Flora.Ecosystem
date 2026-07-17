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
  }

  private fun normalizePath(path: String): String =
    if (path.startsWith("file://")) android.net.Uri.parse(path).path ?: path else path
}
