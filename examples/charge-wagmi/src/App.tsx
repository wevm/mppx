import { useEffect, useState } from 'react'
import { useAccount, useCapabilities, useConnect, useConnectors, useDisconnect } from 'wagmi'
import { Hooks } from 'wagmi/tempo'

import { mppx } from './wagmi'

const currency = '0x20c0000000000000000000000000000000000000' as const // pathUSD
const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

function App() {
  const account = useAccount()
  const { connect } = useConnect()
  const connectors = useConnectors()
  const { disconnect } = useDisconnect()

  return (
    <>
      <h1>Random Photo</h1>
      <p>Pay per photo with a wallet using Wagmi.</p>

      {account.status === 'connected' ? (
        <>
          <p>
            Connected: {account.address?.slice(0, 6)}...{account.address?.slice(-4)}
          </p>
          <button type="button" onClick={() => disconnect()}>
            Disconnect
          </button>
          <Photo />
        </>
      ) : (
        <div>
          <h2>Connect</h2>
          {connectors.map((connector) =>
            connector.type === 'webAuthn' ? (
              <div key={connector.uid}>
                <button type="button" onClick={() => connect({ connector })}>
                  Connect (Passkey)
                </button>
              </div>
            ) : (
              <button key={connector.uid} onClick={() => connect({ connector })} type="button">
                {connector.name}
              </button>
            ),
          )}
        </div>
      )}
    </>
  )
}

function Photo() {
  const { address } = useAccount()
  const capabilities = useCapabilities()
  console.log(capabilities)
  const { data: balance, refetch: refetchBalance } = Hooks.token.useGetBalance({
    account: address,
    token: currency,
    query: { refetchInterval: 4_000 },
  })
  const { mutate: fund, isPending: funding } = Hooks.faucet.useFundSync()

  const [photo, setPhoto] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (balance !== undefined && balance === 0n && address) fund({ account: address })
  }, [balance, address])

  async function handleClick() {
    setLoading(true)
    setError(null)
    try {
      const res = await mppx.fetch('/api/photo')
      if (!res.ok) throw new Error('Request failed')
      const { url } = (await res.json()) as { url: string }
      setPhoto(url)
      refetchBalance()
    } catch (err) {
      console.error(err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  if (funding) return <p>Funding account with testnet tokens...</p>

  return (
    <div style={{ marginTop: '1rem' }}>
      {balance !== undefined && <p>Balance: {formatter.format(Number(balance) / 1e6)}</p>}
      <button type="button" onClick={handleClick} disabled={loading}>
        {loading ? 'Loading...' : 'Generate Photo ($0.01)'}
      </button>

      {error && <p style={{ color: 'red', fontFamily: 'monospace' }}>{error}</p>}

      {photo && (
        <div style={{ marginTop: '1rem' }}>
          <a href={photo} target="_blank" rel="noopener noreferrer">
            <img
              src={photo}
              alt="Random result"
              style={{ width: 400, height: 400, borderRadius: 8 }}
            />
          </a>
        </div>
      )}
    </div>
  )
}

export default App
