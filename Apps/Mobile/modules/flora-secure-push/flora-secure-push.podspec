Pod::Spec.new do |s|
  s.name           = 'flora-secure-push'
  s.version        = '1.0.0'
  s.summary        = 'Flora native encrypted push preview support'
  s.description    = 'Native key lifecycle and FSCP preview bridge.'
  s.author         = 'Flora Ecosystem'
  s.homepage       = 'https://flora.social'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.public_header_files = 'ios/**/*.h'
  s.vendored_frameworks = 'ios/FSCPMobileFFI.xcframework'
end
