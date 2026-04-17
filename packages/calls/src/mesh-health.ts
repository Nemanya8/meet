export interface MeshHealthReport {
  healthy: boolean
  myConnections: string[]
  peerReports: Record<string, string[]>
  asymmetries: Array<{ peerA: string; peerB: string; issue: string }>
}

export class MeshHealthTracker {
  private peerId: string
  private getConnectedPeers: () => string[]
  private reportedConnections = new Map<string, Set<string>>()

  constructor(peerId: string, getConnectedPeers: () => string[]) {
    this.peerId = peerId
    this.getConnectedPeers = getConnectedPeers
  }

  updateReport(peerId: string, connectedPeerIds: string[]): void {
    this.reportedConnections.set(peerId, new Set(connectedPeerIds))
  }

  removeReport(peerId: string): void {
    this.reportedConnections.delete(peerId)
  }

  getMeshHealth(): MeshHealthReport {
    const myConnections = this.getConnectedPeers()
    const mySet = new Set(myConnections)
    const asymmetries: MeshHealthReport['asymmetries'] = []

    const peerReports: Record<string, string[]> = {}
    for (const [peerId, connections] of this.reportedConnections) {
      peerReports[peerId] = Array.from(connections)
    }

    for (const peerId of myConnections) {
      const theirReport = this.reportedConnections.get(peerId)
      if (theirReport && !theirReport.has(this.peerId)) {
        asymmetries.push({
          peerA: this.peerId,
          peerB: peerId,
          issue: `I see ${peerId} but they don't report me`
        })
      }
    }

    for (const [peerId, connections] of this.reportedConnections) {
      for (const otherPeerId of connections) {
        if (otherPeerId === this.peerId) continue
        const otherReport = this.reportedConnections.get(otherPeerId)
        if (otherReport && !otherReport.has(peerId)) {
          asymmetries.push({
            peerA: peerId,
            peerB: otherPeerId,
            issue: `${peerId} sees ${otherPeerId} but not vice versa`
          })
        }
      }

      if (connections.has(this.peerId) && !mySet.has(peerId)) {
        asymmetries.push({
          peerA: peerId,
          peerB: this.peerId,
          issue: `${peerId} reports me but I don't see them`
        })
      }
    }

    return { healthy: asymmetries.length === 0, myConnections, peerReports, asymmetries }
  }
}
