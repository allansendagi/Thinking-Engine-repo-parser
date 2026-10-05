// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ThreadMac",
    // macOS 15: SwiftUI's `Scene.defaultLaunchBehavior(_:)` (keeps the full window from opening
    // at launch) is 15.0+. CI runs on macos-15; there is no shipped 14.x user base. String form
    // so this stays on swift-tools 5.9 (`.v15` needs PackageDescription 6.0).
    platforms: [.macOS("15.0")],
    dependencies: [
        // Auto-updates (see Updater.swift). Binary XCFramework; package.sh embeds it in the .app.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.4"),
    ],
    targets: [
        .executableTarget(
            name: "ThreadMac",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            // Find Sparkle.framework where package.sh puts it: Thread.app/Contents/Frameworks.
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
        .testTarget(name: "ThreadMacTests", dependencies: ["ThreadMac"]),
    ]
)
