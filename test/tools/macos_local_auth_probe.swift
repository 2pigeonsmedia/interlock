// macOS probe: can THIS login session verify the user's identity the way a
// browser passkey ceremony does? Run:  swift test/tools/macos_local_auth_probe.swift
// Prints two lines. No secrets are read or written.
import LocalAuthentication
import Foundation

let context = LAContext()
var why: NSError?
let can = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &why)
print("canEvaluate:", can, why?.localizedDescription ?? "ok")
if !can { exit(1) }

let done = DispatchSemaphore(value: 0)
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Interlock passkey probe") { ok, err in
  print("result:", ok, err?.localizedDescription ?? "ok")
  done.signal()
}
done.wait()
