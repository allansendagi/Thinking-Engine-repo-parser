// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ThreadMac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "ThreadMac"),
        .testTarget(name: "ThreadMacTests", dependencies: ["ThreadMac"]),
    ]
)
