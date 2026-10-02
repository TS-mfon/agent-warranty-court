// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The verdict grammar, shared by every contract that touches a verdict.
/// @dev These rules are a deliberate duplicate of `_normalize` in
///      contracts/genlayer/warranty_court.py. GenLayer already rejects an
///      incoherent verdict before consensus, so re-checking here looks
///      redundant — it is not. The relayer sits between the two chains and is
///      the one party that is merely bonded rather than trusted. Re-deriving
///      the same rules in Solidity means a compromised relayer cannot post a
///      verdict GenLayer would never have produced, and the check costs a few
///      hundred gas on a path that moves thousands of dollars.
///
///      If the Python enum changes, this library must change with it.
library VerdictLib {
    // Violation codes, ordered to match VIOLATION_CODES in the Python contract.
    uint8 internal constant NO_BREACH = 0;
    uint8 internal constant UNSUPPORTED_FACT_HALLUCINATION = 1;
    uint8 internal constant SCHEMA_MALFORMED_OUTPUT = 2;
    uint8 internal constant DEAD_LINK_CITATION = 3;
    uint8 internal constant UNAUTHORIZED_TOOL_CALL = 4;
    uint8 internal constant SILENT_FAILURE = 5;

    /// @notice Not a violation code on GenLayer — it is a case *status* there.
    /// @dev The relayer maps that status onto this code so Base can tell an
    ///      adjudicated acquittal (settle now) apart from a court that could
    ///      not read the evidence (cure window first). Both carry a zero
    ///      payout, so without the distinction the two would be identical on
    ///      Base and the cure window could never trigger.
    uint8 internal constant EVIDENCE_UNAVAILABLE = 6;

    uint8 internal constant MAX_CODE = 6;
    uint8 internal constant MAX_SEVERITY = 3;

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant MIN_BREACH_PAYOUT_BPS = 2_500;

    /// @notice Payout buckets. Not a simplification — a consensus requirement.
    /// @dev Independent validators never converge on a free integer; they
    ///      converge reliably on five values. Enforcing the same closed set on
    ///      Base means an off-bucket payout is unsettleable even if it somehow
    ///      cleared consensus.
    function isBucket(uint16 bps) internal pure returns (bool) {
        return bps == 0 || bps == 2_500 || bps == 5_000 || bps == 7_500 || bps == 10_000;
    }

    /// @notice Cross-field coherence, mirroring the Python `_normalize` rules.
    /// @dev Individually valid fields can still be incoherent together, and
    ///      that specific shape — NO_BREACH carrying a full refund — is what a
    ///      half-successful prompt injection produces.
    function isCoherent(uint8 code, uint16 payoutBps, uint8 severity) internal pure returns (bool) {
        if (code > MAX_CODE) return false;
        if (severity > MAX_SEVERITY) return false;
        if (!isBucket(payoutBps)) return false;

        if (code == NO_BREACH || code == EVIDENCE_UNAVAILABLE) {
            return severity == 0 && payoutBps == 0;
        }
        return severity >= 1 && payoutBps >= MIN_BREACH_PAYOUT_BPS;
    }

    function isBreach(uint8 code) internal pure returns (bool) {
        return code != NO_BREACH && code != EVIDENCE_UNAVAILABLE;
    }

    /// @notice Stake slashed on a breach, as a fraction of the job value.
    /// @dev Scaled by job value rather than by stake balance: slashing a
    ///      percentage of stake would make a single small dispute catastrophic
    ///      for a large provider and trivial for a small one, which inverts the
    ///      incentive the stake exists to create.
    function slashBpsFor(uint8 severity) internal pure returns (uint16) {
        if (severity == 1) return 1_000;
        if (severity == 2) return 2_500;
        if (severity == 3) return 5_000;
        return 0;
    }
}
