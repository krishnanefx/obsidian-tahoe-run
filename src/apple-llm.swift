// Tahoe Run helper: streams a reply from the on-device Apple Intelligence model.
// Prompt on stdin, optional instructions in TAHOE_INSTRUCTIONS, reply text on stdout.
import Foundation
import FoundationModels

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let model = SystemLanguageModel.default
if case .unavailable(let reason) = model.availability {
    fail("Apple Intelligence model unavailable: \(reason)", 2)
}

let prompt = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
let instructions = ProcessInfo.processInfo.environment["TAHOE_INSTRUCTIONS"] ?? ""
let session = LanguageModelSession(instructions: instructions)

do {
    var printed = ""
    for try await snapshot in session.streamResponse(to: prompt) {
        let text = snapshot.content
        if text.hasPrefix(printed) {
            FileHandle.standardOutput.write(Data(String(text.dropFirst(printed.count)).utf8))
        } else {
            FileHandle.standardOutput.write(Data(("\n" + text).utf8))
        }
        printed = text
    }
} catch {
    fail("Apple Intelligence error: \(error)", 1)
}
