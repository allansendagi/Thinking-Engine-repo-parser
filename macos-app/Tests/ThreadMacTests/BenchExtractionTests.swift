import XCTest
@testable import ThreadMac

/// Runs Thread for Mac's own idea extraction -- the code the app uses for every capture
/// (`OnDeviceModel.absorbCapture` folded into a `LocalGraph`) -- over the thinking bench's
/// captures, in the order a person wrote them, and records what it did. The server-side bench then
/// scores it with the same metrics as the cloud pipeline (`bun run bench --on-device`).
///
/// Needs a Mac with Apple Intelligence enabled (macOS 26): the model isn't available in VMs or on
/// Macs without it, in which case the test is skipped and says so. Skipped unless
/// BENCH_CONVERSATIONS is set. Locally:
///
///   bun src/bench/dumpConversations.ts --held-out > /tmp/bench-convs.json
///   BENCH_CONVERSATIONS=/tmp/bench-convs.json BENCH_EXTRACT_OUT=../src/bench/ondevice.results.json \
///     swift test --filter BenchExtractionTests
///
/// See src/bench/ON_DEVICE.md for the decision rule the numbers are judged against.
final class BenchExtractionTests: XCTestCase {
    private struct Input: Decodable {
        struct Capture: Decodable { let id: String; let text: String }
        let scenario: String
        let captures: [Capture]
    }

    private struct Output: Encodable {
        struct Capture: Encodable {
            let id: String
            let ideaId: String?
            let title: String?
            let formulation: String?
            let state: String?
            let openQuestion: String?
            let ms: Int
        }
        struct Scenario: Encodable {
            let scenario: String
            let captures: [Capture]
        }
        let model: String
        let device: String
        let scenarios: [Scenario]
    }

    func testExtractBenchCaptures() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let input = env["BENCH_CONVERSATIONS"], let output = env["BENCH_EXTRACT_OUT"] else {
            throw XCTSkip("BENCH_CONVERSATIONS / BENCH_EXTRACT_OUT not set")
        }
        // A probe: if the model can't answer at all here, say so plainly rather than writing an
        // all-empty results file that would score as "the on-device model captures nothing".
        let probe = await OnDeviceModel.absorbCapture(text: "I think we should price per seat, not per workspace.", existing: [])
        guard probe != nil else {
            throw XCTSkip("The on-device model isn't available on this machine (needs macOS 26 with Apple Intelligence enabled, on Apple silicon). Run this on your own Mac.")
        }

        let scenarios = try JSONDecoder().decode([Input].self, from: Data(contentsOf: URL(fileURLWithPath: input)))
        var out: [Output.Scenario] = []
        for s in scenarios {
            var graph = LocalGraph.empty
            var captures: [Output.Capture] = []
            for c in s.captures {
                let started = Date()
                let delta = await OnDeviceModel.absorbCapture(
                    text: c.text,
                    existing: graph.ideas.map { (id: $0.id, title: $0.title) }
                )
                let ms = Int(Date().timeIntervalSince(started) * 1000)
                guard let delta else {
                    captures.append(.init(id: c.id, ideaId: nil, title: nil, formulation: nil, state: nil, openQuestion: nil, ms: ms))
                    continue
                }
                graph = OnDeviceGraph.fold(delta, captureId: c.id, into: graph)
                // Which idea this capture ended up in: the one it continued, or the one just created.
                let ideaId = graph.ideas.first(where: { $0.id == delta.target })?.id ?? graph.ideas.last?.id
                captures.append(.init(
                    id: c.id, ideaId: ideaId, title: delta.title, formulation: delta.formulation,
                    state: delta.state, openQuestion: delta.openQuestion, ms: ms
                ))
            }
            out.append(.init(scenario: s.scenario, captures: captures))
            print("BenchExtraction: \(s.scenario) -- \(captures.filter { $0.ideaId != nil }.count)/\(captures.count) answered")
        }
        let result = Output(
            model: "Apple Foundation Models",
            device: ProcessInfo.processInfo.operatingSystemVersionString,
            scenarios: out
        )
        let enc = JSONEncoder()
        try enc.encode(result).write(to: URL(fileURLWithPath: output))
    }
}
