import XCTest
@testable import ThreadMac

final class ThinkingLayerTests: XCTestCase {
    func testAskAnswerDecodesAndSaysWhatItRestsOn() throws {
        let json = """
        {"query":"pricing","method":"meaning","conversations":8,"tools":["chatgpt","gemini"],"firstAt":null,"lastAt":null,
         "ideas":[{"ideaId":"i1","title":"Pricing","state":"developing","relevance":0.69,"stance":"Charge per seat.",
                   "decisions":[],"path":[],"openQuestions":[],"related":[]}]}
        """.data(using: .utf8)!
        let a = try JSONDecoder().decode(AskAnswer.self, from: json)
        XCTAssertEqual(a.results.map(\.currentFormulation), ["Charge per seat."])
        XCTAssertEqual(a.context, "Your thinking · 8 conversations · ChatGPT, Gemini")
    }

    func testNoContextWhenNothingMatched() throws {
        let a = AskAnswer(method: "words", ideas: [], conversations: 0, tools: [])
        XCTAssertNil(a.context)
    }

    func testThinkingStateDecodesWithAndWithoutRevisit() throws {
        let base = #""topic":null,"currentIdeas":[],"recentChanges":[],"decisions":[],"openLoops":[],"contradictions":[],"relatedIdeas":[]"#
        let old = try JSONDecoder().decode(ThinkingStateResponse.self, from: "{\(base)}".data(using: .utf8)!)
        XCTAssertNil(old.revisit)
        let new = try JSONDecoder().decode(ThinkingStateResponse.self, from: """
        {\(base),"revisit":[{"ideaId":"i1","ideaTitle":"Pricing","loopId":"loop_q","statement":"Do guests count?","raisedAt":"2026-10-01T00:00:00Z","backOnTopicAt":"2026-10-18T00:00:00Z","via":null}]}
        """.data(using: .utf8)!)
        XCTAssertEqual(new.revisit?.map(\.statement), ["Do guests count?"])
    }
}
