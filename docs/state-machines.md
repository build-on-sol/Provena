# State machines

```mermaid
stateDiagram-v2
  [*] --> Submitted
  Submitted --> Original: originality signature
  Submitted --> PendingSimilarity: review opened
  Original --> PendingSimilarity: review opened
  PendingSimilarity --> Independent: both authors agree
  PendingSimilarity --> Derivative: accepted settlement + rights attestation
```

```mermaid
stateDiagram-v2
  [*] --> Claimable: revenue without dispute
  Claimable --> Paid: valid proof + recipient signature
  Claimable --> Safeguard: fixed deadline elapsed
  Claimable --> DisputeHolding: case opened
  DisputeHolding --> Safeguard: case cutoff elapsed
  DisputeHolding --> Claimable: resolution before cutoff
  Safeguard --> ExitPending: request or late settlement
  ExitPending --> Claimable: requested_at + 48h
  Claimable --> Safeguard: returned amount unclaimed for 7d
```

```mermaid
stateDiagram-v2
  [*] --> PendingReview
  PendingReview --> Negotiating: proposal
  PendingReview --> SafeguardMode: cutoff
  Negotiating --> SafeguardMode: cutoff
  PendingReview --> Independent: both signatures
  Negotiating --> Derivative: accepted final proposal
  SafeguardMode --> Resolved: independent or derivative + automatic exit
```

Time transitions are checked inside financial instructions using Clock, and remain effective without an indexer or scheduled keeper. Partial claims and new deposits cannot move existing deadlines later.
