import { useState, useRef, useEffect } from 'react'
import './App.css'

// --- Types ---
interface Message { role: 'user' | 'assistant'; content: string }
interface Conversation { id: string; title: string; messages: Message[] }

// --- Storage ---
const PROFILES_KEY = 'iliagpt-profiles'
const CURRENT_KEY  = 'iliagpt-current'
const convosKey = (p: string) => `iliagpt-convos-${p}`

const loadProfiles = (): string[] => {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]') } catch { return [] }
}
const saveProfiles = (ps: string[]) => localStorage.setItem(PROFILES_KEY, JSON.stringify(ps))
const loadCurrentProfile = (): string | null => localStorage.getItem(CURRENT_KEY)
const saveCurrentProfile = (p: string | null) =>
  p ? localStorage.setItem(CURRENT_KEY, p) : localStorage.removeItem(CURRENT_KEY)

const loadConvos = (profile: string): Conversation[] => {
  try { return JSON.parse(localStorage.getItem(convosKey(profile)) || '[]') } catch { return [] }
}
const saveConvos = (profile: string, convos: Conversation[]) =>
  localStorage.setItem(convosKey(profile), JSON.stringify(convos))

// --- Helpers ---
const makeConvo = (): Conversation => ({ id: crypto.randomUUID(), title: 'New conversation', messages: [] })

const profileColor = (name: string): string => {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return `hsl(${Math.abs(h) % 360}, 55%, 52%)`
}

function initChatForProfile(profile: string) {
  let saved = loadConvos(profile)
  if (saved.length === 0) {
    const first = makeConvo()
    saved = [first]
    saveConvos(profile, saved)
  }
  return { convos: saved, activeId: saved[0].id }
}

// --- Groq ---
async function askGroq(apiKey: string, messages: Message[]): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'You are the person in the picture. Answer questions in first person, casually and conversationally. Keep answers short (2-3 sentences max).' },
        ...messages,
      ],
    }),
  })
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? 'Sorry, something went wrong.'
}

// --- Profile Select Screen ---
function ProfileSelect({ onSelect }: { onSelect: (name: string) => void }) {
  const [profiles, setProfiles] = useState(loadProfiles)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const create = () => {
    const name = newName.trim()
    if (!name) return
    const updated = [...profiles, name]
    setProfiles(updated)
    saveProfiles(updated)
    onSelect(name)
  }

  const deleteProfile = (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const updated = profiles.filter(p => p !== name)
    setProfiles(updated)
    saveProfiles(updated)
    localStorage.removeItem(convosKey(name))
  }

  return (
    <div className="profile-screen">
      <h1 className="profile-heading">Who's using IliaGPT?</h1>
      <div className="profile-grid">
        {profiles.map(p => (
          <div key={p} className="profile-card-wrap">
            <button className="profile-card" onClick={() => onSelect(p)}>
              <div className="profile-avatar" style={{ background: profileColor(p) }}>
                {p[0].toUpperCase()}
              </div>
              <span className="profile-name">{p}</span>
            </button>
            <button className="profile-card-delete" onClick={e => deleteProfile(p, e)} title="Delete profile">×</button>
          </div>
        ))}
        {!creating && (
          <button className="profile-card profile-new" onClick={() => setCreating(true)}>
            <div className="profile-avatar profile-avatar-add">+</div>
            <span className="profile-name">New Profile</span>
          </button>
        )}
      </div>
      {creating && (
        <form className="profile-create" onSubmit={e => { e.preventDefault(); create() }}>
          <input
            autoFocus
            placeholder="Enter your name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!newName.trim()}>Create</button>
          {profiles.length > 0 && (
            <button type="button" className="btn-cancel" onClick={() => setCreating(false)}>Cancel</button>
          )}
        </form>
      )}
      {profiles.length === 0 && !creating && (
        <button className="profile-create-first" onClick={() => setCreating(true)}>
          Create your profile to get started
        </button>
      )}
    </div>
  )
}

// --- Main App ---
function App() {
  const [currentProfile, setCurrentProfile] = useState<string | null>(loadCurrentProfile)

  const [chatInit] = useState(() => {
    const p = loadCurrentProfile()
    if (!p) return null
    return initChatForProfile(p)
  })

  const [convos, setConvos] = useState<Conversation[]>(chatInit?.convos ?? [])
  const [activeId, setActiveId] = useState<string>(chatInit?.activeId ?? '')
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoice] = useState('')

  const imgRef = useRef<HTMLImageElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const jumpTimeouts = useRef<number[]>([])

  const activeConvo = convos.find(c => c.id === activeId) ?? null

  const selectProfile = (name: string) => {
    saveCurrentProfile(name)
    const { convos: c, activeId: a } = initChatForProfile(name)
    setConvos(c)
    setActiveId(a)
    setCurrentProfile(name)
    setInput('')
  }

  const switchProfile = () => {
    window.speechSynthesis.cancel()
    jumpTimeouts.current.forEach(clearTimeout)
    saveCurrentProfile(null)
    setCurrentProfile(null)
  }

  useEffect(() => {
    const load = () => {
      const v = window.speechSynthesis.getVoices()
      if (v.length > 0) {
        setVoices(v)
        setSelectedVoice(prev => prev || v[0].name)
      }
    }
    load()
    window.speechSynthesis.onvoiceschanged = load
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeConvo?.messages.length])

  const triggerJump = (durationMs: number) => {
    const img = imgRef.current
    if (!img) return
    img.style.setProperty('--jump-dur', `${durationMs}ms`)
    img.classList.remove('jumping')
    void img.offsetWidth
    img.classList.add('jumping')
  }

  const speak = (text: string) => {
    window.speechSynthesis.cancel()
    jumpTimeouts.current.forEach(clearTimeout)
    jumpTimeouts.current = []
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = voices.find(v => v.name === selectedVoice)
    if (voice) utterance.voice = voice
    const words = text.trim().split(/\s+/)
    let elapsed = 0
    jumpTimeouts.current = words.map(word => {
      const dur = Math.max(100, Math.min(600, 80 + word.length * 55))
      const t = elapsed
      elapsed += dur
      return window.setTimeout(() => triggerJump(dur), t)
    })
    utterance.onend = () => { jumpTimeouts.current.forEach(clearTimeout); imgRef.current?.classList.remove('jumping') }
    utterance.onerror = () => { jumpTimeouts.current.forEach(clearTimeout); imgRef.current?.classList.remove('jumping') }
    window.speechSynthesis.speak(utterance)
  }

  const newConvo = () => {
    if (!currentProfile) return
    const convo = makeConvo()
    const updated = [convo, ...convos]
    setConvos(updated)
    saveConvos(currentProfile, updated)
    setActiveId(convo.id)
  }

  const deleteConvo = (id: string) => {
    if (!currentProfile) return
    let updated = convos.filter(c => c.id !== id)
    if (updated.length === 0) updated = [makeConvo()]
    setConvos(updated)
    saveConvos(currentProfile, updated)
    if (activeId === id) setActiveId(updated[0].id)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading || !activeConvo || !currentProfile) return
    const userMsg: Message = { role: 'user', content: input.trim() }
    const newMessages = [...activeConvo.messages, userMsg]
    const title = activeConvo.messages.length === 0 ? input.trim().slice(0, 40) : activeConvo.title
    const withUser = convos.map(c => c.id === activeId ? { ...c, title, messages: newMessages } : c)
    setConvos(withUser)
    saveConvos(currentProfile, withUser)
    setInput('')
    setIsLoading(true)
    try {
      const reply = await askGroq(import.meta.env.VITE_GROQ_API_KEY, newMessages)
      const withReply = withUser.map(c =>
        c.id === activeId ? { ...c, messages: [...newMessages, { role: 'assistant' as const, content: reply }] } : c
      )
      setConvos(withReply)
      saveConvos(currentProfile, withReply)
      speak(reply)
    } catch { /* silently fail */ }
    setIsLoading(false)
  }

  if (!currentProfile) return <ProfileSelect onSelect={selectProfile} />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="profile-bar">
          <div className="profile-badge" style={{ background: profileColor(currentProfile) }}>
            {currentProfile[0].toUpperCase()}
          </div>
          <span className="profile-bar-name">{currentProfile}</span>
          <button className="profile-switch-btn" onClick={switchProfile}>Switch</button>
        </div>
        <button className="new-chat-btn" onClick={newConvo}>+ New conversation</button>
        <div className="convo-list">
          {convos.map(c => (
            <div key={c.id} className={`convo-row ${c.id === activeId ? 'active' : ''}`}>
              <button className="convo-item" onClick={() => setActiveId(c.id)}>{c.title}</button>
              <button className="convo-delete" onClick={() => deleteConvo(c.id)} title="Delete">×</button>
            </div>
          ))}
        </div>
        {voices.length > 0 && (
          <select className="voice-select" value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}>
            {voices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        )}
      </aside>

      <main className="main">
        <h1 className="site-title">Whachu know bout IliaGPT?</h1>
        <div className="avatar-area">
          <img
            ref={imgRef}
            src="/me.png"
            alt="me"
            className="avatar"
            onAnimationEnd={() => imgRef.current?.classList.remove('jumping')}
          />
        </div>
        <div className="messages">
          {activeConvo?.messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <div className="bubble">{msg.content}</div>
            </div>
          ))}
          {isLoading && <div className="message assistant"><div className="bubble typing">...</div></div>}
          <div ref={messagesEndRef} />
        </div>
        <form onSubmit={handleSubmit} className="input-bar">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask me anything..."
            disabled={isLoading}
            autoFocus
          />
          <button type="submit" disabled={isLoading || !input.trim()}>
            {isLoading ? '...' : 'Ask'}
          </button>
        </form>
      </main>
    </div>
  )
}

export default App
