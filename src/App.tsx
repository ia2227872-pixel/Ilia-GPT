import React, { useState, useRef, useEffect } from 'react'
import './App.css'

// --- Types ---
interface Message { role: 'user' | 'assistant'; content: string }
interface Conversation { id: string; title: string; messages: Message[] }
interface Profile { name: string; color: string }

// --- Color Helpers ---
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

function hsvToHex({ h, s, v }: { h: number; s: number; v: number }): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16).padStart(2, '0')
  }
  return `#${f(5)}${f(3)}${f(1)}`
}


function darkenHex(hex: string, amount = 0.18): string {
  const { h, s, v } = hexToHsv(hex)
  return hsvToHex({ h, s, v: Math.max(0, v - amount) })
}

function legacyColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return `hsl(${Math.abs(h) % 360}, 55%, 52%)`
}

// --- Storage ---
const PROFILES_KEY = 'iliagpt-profiles'
const CURRENT_KEY  = 'iliagpt-current'
const convosKey = (name: string) => `iliagpt-convos-${name}`

const loadProfiles = (): Profile[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]')
    return (raw as (string | Profile)[]).map(p =>
      typeof p === 'string' ? { name: p, color: legacyColor(p) } : p
    )
  } catch { return [] }
}
const saveProfiles = (ps: Profile[]) => localStorage.setItem(PROFILES_KEY, JSON.stringify(ps))

const loadCurrentProfile = (): Profile | null => {
  const name = localStorage.getItem(CURRENT_KEY)
  if (!name) return null
  return loadProfiles().find(p => p.name === name) ?? null
}
const saveCurrentProfile = (name: string | null) =>
  name ? localStorage.setItem(CURRENT_KEY, name) : localStorage.removeItem(CURRENT_KEY)

const loadConvos = (name: string): Conversation[] => {
  try { return JSON.parse(localStorage.getItem(convosKey(name)) || '[]') } catch { return [] }
}
const saveConvos = (name: string, convos: Conversation[]) =>
  localStorage.setItem(convosKey(name), JSON.stringify(convos))

// --- Helpers ---
const makeConvo = (): Conversation => ({ id: crypto.randomUUID(), title: 'New conversation', messages: [] })

function initChatForProfile(name: string) {
  let saved = loadConvos(name)
  if (saved.length === 0) {
    const first = makeConvo()
    saved = [first]
    saveConvos(name, saved)
  }
  return { convos: saved, activeId: saved[0].id }
}


// --- Image Generation ---
type MsgPart = { type: 'text'; text: string } | { type: 'generate'; prompt: string }

function parseAssistantMessage(content: string): MsgPart[] {
  const parts: MsgPart[] = []
  const regex = /\[GENERATE:\s*([^\]]+)\]/gi
  let last = 0, match
  while ((match = regex.exec(content)) !== null) {
    if (match.index > last) parts.push({ type: 'text', text: content.slice(last, match.index).trim() })
    parts.push({ type: 'generate', prompt: match[1].trim() })
    last = match.index + match[0].length
  }
  if (last < content.length) parts.push({ type: 'text', text: content.slice(last).trim() })
  return parts.filter(p => p.type !== 'text' || (p as { type: 'text'; text: string }).text.length > 0)
}

function GeneratingImage({ prompt }: { prompt: string }) {
  const [progress, setProgress] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (progress >= 100) { setStalled(false); return }
    setStalled(false)
    const t = setTimeout(() => setStalled(true), 5000)
    return () => clearTimeout(t)
  }, [progress])

  useEffect(() => {
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let initialWaitTime: number | null = null

    const poll = async (id: string) => {
      if (cancelled) return
      try {
        const res = await fetch(`https://stablehorde.net/api/v2/generate/check/${id}`)
        const check = await res.json()
        if (cancelled) return

        if (check.faulted) { setFailed(true); return }

        if (initialWaitTime === null && check.wait_time > 0) {
          initialWaitTime = check.wait_time
        }

        if (check.done) {
          setProgress(95)
          const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${id}`)
          const status = await statusRes.json()
          if (cancelled) return
          const imgUrl = status.generations?.[0]?.img
          if (imgUrl) {
            setProgress(100)
            setUrl(imgUrl)
          } else {
            setFailed(true)
          }
        } else {
          if (initialWaitTime && initialWaitTime > 0) {
            const elapsed = initialWaitTime - (check.wait_time ?? 0)
            const pct = Math.min(90, Math.max(5, Math.round((elapsed / initialWaitTime) * 85) + 5))
            setProgress(pct)
          } else if (check.processing > 0) {
            setProgress(prev => Math.min(90, Math.round(prev + (90 - prev) * 0.1)))
          }
          pollTimer = setTimeout(() => poll(id), 2000)
        }
      } catch {
        if (!cancelled) pollTimer = setTimeout(() => poll(id), 3000)
      }
    }

    const start = async () => {
      try {
        setProgress(3)
        const res = await fetch('https://stablehorde.net/api/v2/generate/async', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': '0000000000',
            'Client-Agent': 'IliaGPT:1.0:unknown'
          },
          body: JSON.stringify({
            prompt,
            params: { width: 512, height: 512, n: 1, steps: 25, sampler_name: 'k_euler' }
          })
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const { id } = await res.json()
        if (cancelled) return
        setProgress(5)
        pollTimer = setTimeout(() => poll(id), 2000)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    start()
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [prompt])

  if (failed) return <span className="gen-failed">couldn't generate that image lol</span>
  if (url) return <img src={url} alt="generated image" className="chat-image" />
  return (
    <div className="generating-image-wrap">
      <div className="gen-progress-wrap">
        <span className="gen-progress-label">
          Generating image... {Math.round(progress)}%
          {stalled && <span className="gen-spinner" />}
        </span>
        <div className="gen-progress-track">
          <div className="gen-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  )
}

// --- Groq ---
async function askGroq(apiKey: string, messages: Message[]): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 400,
      messages: [
        { role: 'system', content: 'Your name is Ilia. You are a real person. Answer all questions as Ilia, in first person, casually and conversationally. Keep answers short (2-3 sentences max). When the user asks you to generate or make an image, include [GENERATE: detailed visual description] in your response where you want the image to appear.' },
        ...messages,
      ],
    }),
  })
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? 'Sorry, something went wrong.'
}

// --- Color Picker ---
function ColorPicker({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [hsv, setHsv] = useState<{ h: number; s: number; v: number }>(() => {
    try { return hexToHsv(color) } catch { return { h: 260, s: 0.6, v: 1 } }
  })
  const hsvRef = useRef(hsv)
  hsvRef.current = hsv
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const squareRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<'square' | 'hue' | null>(null)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const cur = dragging.current
      if (!cur) return
      if (cur === 'square' && squareRef.current) {
        const rect = squareRef.current.getBoundingClientRect()
        const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const v = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
        const next = { ...hsvRef.current, s, v }
        hsvRef.current = next; setHsv(next); onChangeRef.current(hsvToHex(next))
      } else if (cur === 'hue' && hueRef.current) {
        const rect = hueRef.current.getBoundingClientRect()
        const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360))
        const next = { ...hsvRef.current, h }
        hsvRef.current = next; setHsv(next); onChangeRef.current(hsvToHex(next))
      }
    }
    const up = () => { dragging.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  const startSquare = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragging.current = 'square'
    const rect = squareRef.current!.getBoundingClientRect()
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const v = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    const next = { ...hsvRef.current, s, v }
    hsvRef.current = next; setHsv(next); onChangeRef.current(hsvToHex(next))
  }

  const startHue = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragging.current = 'hue'
    const rect = hueRef.current!.getBoundingClientRect()
    const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360))
    const next = { ...hsvRef.current, h }
    hsvRef.current = next; setHsv(next); onChangeRef.current(hsvToHex(next))
  }

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 })
  return (
    <div className="color-picker" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <div ref={squareRef} className="cp-square" style={{ background: hueColor }} onMouseDown={startSquare}>
        <div className="cp-sq-white" />
        <div className="cp-sq-black" />
        <div className="cp-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div ref={hueRef} className="cp-hue" onMouseDown={startHue}>
        <div className="cp-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
      </div>
    </div>
  )
}

// --- Profile Select Screen ---
function ProfileSelect({ onSelect }: { onSelect: (profile: Profile) => void }) {
  const [profiles, setProfiles] = useState(loadProfiles)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#6c63ff')
  const [showCreatePicker, setShowCreatePicker] = useState(false)
  const [renamingProfile, setRenamingProfile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameColor, setRenameColor] = useState('#6c63ff')
  const [showRenamePicker, setShowRenamePicker] = useState(false)

  const create = () => {
    const name = newName.trim()
    if (!name) return
    const profile: Profile = { name, color: newColor }
    const updated = [...profiles, profile]
    setProfiles(updated)
    saveProfiles(updated)
    onSelect(profile)
  }

  const deleteProfile = (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const updated = profiles.filter(p => p.name !== name)
    setProfiles(updated)
    saveProfiles(updated)
    localStorage.removeItem(convosKey(name))
  }

  const startRename = (profile: Profile, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingProfile(profile.name)
    setRenameValue(profile.name)
    setRenameColor(profile.color)
    setShowRenamePicker(false)
  }

  const confirmRename = (oldName: string, e: React.FormEvent) => {
    e.preventDefault()
    const name = renameValue.trim()
    if (name) {
      if (name !== oldName) {
        const existing = localStorage.getItem(convosKey(oldName))
        if (existing) localStorage.setItem(convosKey(name), existing)
        localStorage.removeItem(convosKey(oldName))
        if (localStorage.getItem(CURRENT_KEY) === oldName) localStorage.setItem(CURRENT_KEY, name)
      }
      const updated = profiles.map(p => p.name === oldName ? { name, color: renameColor } : p)
      setProfiles(updated)
      saveProfiles(updated)
    }
    setRenamingProfile(null)
    setShowRenamePicker(false)
  }

  return (
    <div className="profile-screen">
      <h1 className="profile-heading">Who's using IliaGPT?</h1>
      <div className="profile-grid">
        {profiles.map(p => (
          <div key={p.name} className="profile-card-wrap">
            {renamingProfile === p.name ? (
              <form className="profile-rename-form" style={{ borderColor: renameColor }} onSubmit={e => confirmRename(p.name, e)}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onClick={e => e.stopPropagation()}
                />
                <button
                  type="button"
                  className="color-swatch-btn"
                  style={{ background: renameColor }}
                  onClick={e => { e.stopPropagation(); setShowRenamePicker(v => !v) }}
                  title="Pick color"
                />
                {showRenamePicker && <ColorPicker color={renameColor} onChange={setRenameColor} />}
                <div>
                  <button type="submit">✓</button>
                  <button type="button" onClick={() => { setRenamingProfile(null); setShowRenamePicker(false) }}>✕</button>
                </div>
              </form>
            ) : (
              <button className="profile-card" onClick={() => onSelect(p)}>
                <div className="profile-avatar" style={{ background: p.color }}>
                  {p.name[0].toUpperCase()}
                </div>
                <span className="profile-name">{p.name}</span>
              </button>
            )}
            {renamingProfile !== p.name && (
              <>
                <button className="profile-card-rename" onClick={e => startRename(p, e)} title="Rename profile">✎</button>
                <button className="profile-card-delete" onClick={e => deleteProfile(p.name, e)} title="Delete profile">×</button>
              </>
            )}
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
        <div className="profile-create-wrap">
          <form className="profile-create" onSubmit={e => { e.preventDefault(); create() }}>
            <input
              autoFocus
              placeholder="Enter your name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
            <button
              type="button"
              className="color-swatch-btn"
              style={{ background: newColor }}
              onClick={() => setShowCreatePicker(v => !v)}
              title="Pick color"
            />
            <button type="submit" disabled={!newName.trim()}>Create</button>
            {profiles.length > 0 && (
              <button type="button" className="btn-cancel" onClick={() => { setCreating(false); setShowCreatePicker(false) }}>Cancel</button>
            )}
          </form>
          {showCreatePicker && <ColorPicker color={newColor} onChange={setNewColor} />}
        </div>
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
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(loadCurrentProfile)

  const [chatInit] = useState(() => {
    const p = loadCurrentProfile()
    if (!p) return null
    return initChatForProfile(p.name)
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

  const selectProfile = (profile: Profile) => {
    saveCurrentProfile(profile.name)
    const { convos: c, activeId: a } = initChatForProfile(profile.name)
    setConvos(c)
    setActiveId(a)
    setCurrentProfile(profile)
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
    jumpTimeouts.current.forEach(t => { clearTimeout(t); clearInterval(t) })
    jumpTimeouts.current = []

    const utterance = new SpeechSynthesisUtterance(text)
    const voice = voices.find(v => v.name === selectedVoice)
    if (voice) utterance.voice = voice

    const words = text.trim().split(/\s+/)
    let elapsed = 0
    words.forEach(word => {
      const dur = Math.max(150, Math.min(700, 120 + word.length * 65))
      jumpTimeouts.current.push(window.setTimeout(() => triggerJump(dur), elapsed))
      elapsed += dur
    })

    jumpTimeouts.current.push(window.setTimeout(() => {
      if (window.speechSynthesis.speaking) {
        const interval = window.setInterval(() => {
          if (!window.speechSynthesis.speaking) { clearInterval(interval); return }
          triggerJump(300)
        }, 350)
        jumpTimeouts.current.push(interval)
      }
    }, elapsed))

    const cleanup = () => {
      jumpTimeouts.current.forEach(t => { clearTimeout(t); clearInterval(t) })
      jumpTimeouts.current = []
      imgRef.current?.classList.remove('jumping')
    }
    utterance.onend = cleanup
    utterance.onerror = cleanup
    window.speechSynthesis.speak(utterance)
  }

  const newConvo = () => {
    if (!currentProfile) return
    const convo = makeConvo()
    const updated = [convo, ...convos]
    setConvos(updated)
    saveConvos(currentProfile.name, updated)
    setActiveId(convo.id)
  }

  const deleteConvo = (id: string) => {
    if (!currentProfile) return
    let updated = convos.filter(c => c.id !== id)
    if (updated.length === 0) updated = [makeConvo()]
    setConvos(updated)
    saveConvos(currentProfile.name, updated)
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
    saveConvos(currentProfile.name, withUser)
    setInput('')
    setIsLoading(true)
    try {
      const reply = await askGroq(import.meta.env.VITE_GROQ_API_KEY, newMessages)
      const withReply = withUser.map(c =>
        c.id === activeId ? { ...c, messages: [...newMessages, { role: 'assistant' as const, content: reply }] } : c
      )
      setConvos(withReply)
      saveConvos(currentProfile.name, withReply)
      const textOnly = parseAssistantMessage(reply).filter(p => p.type === 'text').map(p => p.text).join(' ')
      speak(textOnly)
    } catch { /* silently fail */ }
    setIsLoading(false)
  }

  if (!currentProfile) return <ProfileSelect onSelect={selectProfile} />

  const accentDark = darkenHex(currentProfile.color)

  return (
    <div className="app" style={{ '--accent': currentProfile.color, '--accent-dark': accentDark } as React.CSSProperties}>
      <aside className="sidebar">
        <div className="profile-bar">
          <div className="profile-badge" style={{ background: currentProfile.color }}>
            {currentProfile.name[0].toUpperCase()}
          </div>
          <span className="profile-bar-name">{currentProfile.name}</span>
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
          {(() => {
            return activeConvo?.messages.map((msg, i) => {
              const showReaction = msg.role === 'assistant' && (((i * 1103515245 + 12345) >>> 0) % 100 < 5)
              return (
                <React.Fragment key={i}>
                  {showReaction && (
                    <div className="reaction-wrap">
                      <img src="/reaction.png" className="reaction-img" alt="reaction" />
                    </div>
                  )}
                  <div className={`message ${msg.role}`}>
                    {msg.role === 'assistant' ? (
                      <div className="bubble">
                        {parseAssistantMessage(msg.content).map((part, pi) =>
                          part.type === 'text'
                            ? <span key={pi}>{part.text}</span>
                            : <GeneratingImage key={pi} prompt={part.prompt} />
                        )}
                      </div>
                    ) : (
                      <div className="bubble">{msg.content}</div>
                    )}
                  </div>
                </React.Fragment>
              )
            })
          })()}
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
