import XCTest
@testable import ThreadMac

final class InstallIdentityTests: XCTestCase {
    func testMadeOnceAndKeptAcrossCalls() {
        let d = UserDefaults(suiteName: "install-id-test-\(UUID().uuidString)")!
        let a = InstallIdentity.id(in: d)
        XCTAssertNotNil(UUID(uuidString: a))
        XCTAssertEqual(InstallIdentity.id(in: d), a)
    }

    func testReplacesAMalformedValue() {
        let d = UserDefaults(suiteName: "install-id-test-\(UUID().uuidString)")!
        d.set("garbage", forKey: InstallIdentity.defaultsKey)
        XCTAssertNotNil(UUID(uuidString: InstallIdentity.id(in: d)))
    }

    func testOSVersionShape() {
        XCTAssertNotNil(InstallIdentity.osVersion.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression))
    }
}
