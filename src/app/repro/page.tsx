'use client'

import { useState, useRef, useCallback } from 'react'
import { createStatementStore, createAccountsProvider, type ProductAccountId } from '@novasamatech/product-sdk'
import { blake2b256 } from '@polkadot-labs/hdkd-helpers'

function stringToTopic(str: string): Uint8Array {
  return blake2b256(new TextEncoder().encode(str))
}

const store = createStatementStore()
const accounts = createAccountsProvider()

const TOPIC = 'bug-repro-test'

interface LogEntry {
  time: string
  msg: string
  type: 'info' | 'success' | 'error' | 'warn' | 'blockchain' | 'dim'
}

export default function ReproPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [subscribed, setSubscribed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const docId = useRef('repro-' + Math.random().toString(36).slice(2, 8))

  const log = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toISOString().slice(11, 23)
    setLogs(prev => [...prev, { time, msg, type }])
  }, [])

  const handleSubscribe = useCallback(async () => {
    if (subscribed) {
      log('Already subscribed', 'warn')
      return
    }

    log('Subscribing to statement store...', 'blockchain')
    const topics = [stringToTopic(TOPIC), stringToTopic(docId.current)]

    try {
      store.subscribe(topics, (statements) => {
        log(`Received ${statements.length} statement(s) from subscription`, 'success')
        for (const stmt of statements) {
          log(`  Keys: [${Object.keys(stmt).join(', ')}]`, 'dim')
          if (stmt.proof) {
            log(`  Proof tag: "${(stmt.proof as { tag: string }).tag}"`, 'info')
          }
          if (stmt.data) {
            try {
              const text = new TextDecoder().decode(stmt.data)
              log(`  Data: ${text}`, 'dim')
            } catch {
              log(`  Data: ${stmt.data.length} bytes`, 'dim')
            }
          }
        }
      })

      setSubscribed(true)
      log('Subscription active. Submit a statement to trigger the bug.', 'success')
      log('Watch browser console for "e[t] is not a function" error', 'warn')
    } catch (err) {
      log(`Subscribe failed: ${err}`, 'error')
    }
  }, [subscribed, log])

  const handleSubmit = useCallback(async () => {
    if (!subscribed) {
      log('Subscribe first!', 'warn')
      return
    }

    setSubmitting(true)

    try {
      const accountId: ProductAccountId = ['bug-repro.dot', 0]

      const data = new TextEncoder().encode(JSON.stringify({
        type: 'test',
        message: 'This triggers the host codec crash on receive',
        timestamp: Date.now()
      }))

      const expiryTimestampSecs = Math.floor(Date.now() / 1000) + 600
      const seq = Date.now() % 0xFFFFFFFF
      const expiry = (BigInt(expiryTimestampSecs) << BigInt(32)) | BigInt(seq)

      const statement = {
        proof: undefined,
        decryptionKey: stringToTopic(docId.current),
        expiry,
        channel: stringToTopic(`${docId.current}/test`),
        topics: [stringToTopic(TOPIC), stringToTopic(docId.current)],
        data
      }

      log('Creating proof...', 'blockchain')
      const proof = await store.createProof(accountId, statement)
      log(`Proof created (tag: "${proof.tag}")`, 'success')

      const signedStatement = { ...statement, proof }

      log('Submitting statement...', 'blockchain')
      await store.submit(signedStatement)
      log('Statement submitted!', 'success')

      log('', 'dim')
      log('Waiting for subscription to receive it back...', 'warn')
      log('The host will try to forward this via the subscription callback.', 'warn')
      log('The host-api codec will crash decoding sdk-statement format.', 'warn')
      log('Check browser console (F12) for the error!', 'error')
    } catch (err) {
      log(`Submit failed: ${err}`, 'error')
      if (err && typeof err === 'object') {
        log(`Details: ${JSON.stringify(err)}`, 'dim')
      }
    } finally {
      setSubmitting(false)
    }
  }, [subscribed, log])

  const colors: Record<LogEntry['type'], string> = {
    info: '#8ab4f8',
    success: '#81c995',
    error: '#f28b82',
    warn: '#fdd663',
    blockchain: '#c58af9',
    dim: '#6e7681'
  }

  return (
    <div style={{ fontFamily: 'monospace', background: '#1a1a2e', color: '#e0e0e0', padding: 24, minHeight: '100vh' }}>
      <h1 style={{ color: '#8ab4f8', marginBottom: 8, fontSize: 18 }}>
        Statement Store Subscribe Bug Repro
      </h1>
      <p style={{ color: '#9aa0a6', marginBottom: 24, fontSize: 13 }}>
        Demonstrates the codec crash in Polkadot Desktop when forwarding subscribed statements to a papp.
        <br />
        Steps: 1) Subscribe to a topic → 2) Submit a statement to that topic → 3) Watch the host crash on receive.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          onClick={handleSubscribe}
          disabled={subscribed}
          style={{
            padding: '10px 20px', border: 'none', borderRadius: 6, cursor: subscribed ? 'not-allowed' : 'pointer',
            fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold',
            background: '#8ab4f8', color: '#1a1a2e', opacity: subscribed ? 0.4 : 1
          }}
        >
          1. Subscribe
        </button>
        <button
          onClick={handleSubmit}
          disabled={!subscribed || submitting}
          style={{
            padding: '10px 20px', border: 'none', borderRadius: 6, cursor: (!subscribed || submitting) ? 'not-allowed' : 'pointer',
            fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold',
            background: '#81c995', color: '#1a1a2e', opacity: (!subscribed || submitting) ? 0.4 : 1
          }}
        >
          {submitting ? 'Submitting...' : '2. Submit Statement'}
        </button>
        <button
          onClick={() => setLogs([])}
          style={{
            padding: '10px 20px', border: 'none', borderRadius: 6, cursor: 'pointer',
            fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold',
            background: '#3c4043', color: '#e0e0e0'
          }}
        >
          Clear Log
        </button>
      </div>

      <div style={{
        background: '#0d1117', border: '1px solid #30363d', borderRadius: 8,
        padding: 16, height: 500, overflowY: 'auto', fontSize: 12, lineHeight: 1.6
      }}>
        <div style={{ color: '#6e7681' }}>Document ID: {docId.current}</div>
        <div style={{ color: '#6e7681', marginBottom: 8 }}>Topic: {TOPIC}</div>
        {logs.map((entry, i) => (
          <div key={i} style={{ color: colors[entry.type] }}>
            {entry.msg ? `[${entry.time}] ${entry.msg}` : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
