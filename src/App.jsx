import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const ROOM_STORAGE_KEY = 'collabRooms'
const CURRENT_USER_KEY = 'collabCurrentUser'
const PRESENCE_STORAGE_PREFIX = 'room-presence:'
const PRESENCE_TTL_MS = 45_000
const colorPalette = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
]

const getInitials = (name = '') => {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase() ?? '')
    .join('')
}

const generateUserColor = () =>
  colorPalette[Math.floor(Math.random() * colorPalette.length)]

const buildPresenceKey = (roomId) => `${PRESENCE_STORAGE_PREFIX}${roomId}`

const prunePresenceSnapshot = (snapshot) => {
  const now = Date.now()
  return Object.entries(snapshot ?? {}).reduce((acc, [userId, entry]) => {
    if (!entry?.lastSeen || now - entry.lastSeen <= PRESENCE_TTL_MS) {
      acc[userId] = entry
    }
    return acc
  }, {})
}

const buildRoomUrl = (roomId) => {
  const url = new URL(window.location.href)
  url.searchParams.set('roomId', roomId)
  return url.toString()
}

const openCollaborativeWindow = (roomId) => {
  const targetUrl = buildRoomUrl(roomId)
  const popup = window.open(targetUrl, '_blank', 'noopener,noreferrer')

  if (!popup) {
    alert(
      'Please allow pop-ups for this site so we can open the collaborative workspace.'
    )
    return false
  }

  return true
}

const readRoomsFromStorage = () => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(ROOM_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const readCurrentUserFromStorage = () => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CURRENT_USER_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed?.id && parsed?.name) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

const persistCurrentUser = (user) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user))
}

const generateChallenge = () => {
  const first = Math.floor(Math.random() * 6) + 2
  const second = Math.floor(Math.random() * 6) + 2

  return {
    first,
    second,
    answer: first + second,
  }
}

const generateTempId = () => {
  const randomPart =
    globalThis.crypto?.randomUUID?.().slice(0, 6) ??
    Math.random().toString(36).slice(2, 8)
  return `temp-${Date.now().toString(36)}-${randomPart}`
}

const generateRoomId = () => {
  const randomPart =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ??
    Math.random().toString(36).slice(2, 10)
  return `room-${Date.now().toString(36)}-${randomPart}`
}

const readDocSnapshot = (key, roomId) => {
  if (typeof window === 'undefined') {
    return {
      text: `# Room ${roomId}\n\nStart collaborating here...`,
      updatedAt: Date.now(),
    }
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return {
        text: `# Room ${roomId}\n\nStart collaborating here...`,
        updatedAt: Date.now(),
      }
    }

    const parsed = JSON.parse(raw)
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return {
      text: `# Room ${roomId}\n\nStart collaborating here...`,
      updatedAt: Date.now(),
    }
  }
}

const readPresenceSnapshot = (key) => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : {}
    return prunePresenceSnapshot(parsed)
  } catch {
    return {}
  }
}

const persistPresenceSnapshot = (key, snapshot) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(snapshot))
}

const removeUserFromPresenceSnapshot = (key, userId) => {
  if (typeof window === 'undefined' || !userId) return
  const snapshot = readPresenceSnapshot(key)
  delete snapshot[userId]
  persistPresenceSnapshot(key, snapshot)
}

const CollaborativeWorkspace = ({ roomId, currentUser, onExit }) => {
  const storageKey = `room-doc:${roomId}`
  const presenceStorageKey = buildPresenceKey(roomId)
  const [{ text, updatedAt }, setDocState] = useState(() =>
    readDocSnapshot(storageKey, roomId)
  )
  const [presence, setPresence] = useState(() =>
    readPresenceSnapshot(presenceStorageKey)
  )
  const [isChannelReady, setIsChannelReady] = useState(false)
  const lastUpdateRef = useRef(updatedAt)
  const channelRef = useRef(null)
  const editorRef = useRef(null)

  const presenceList = useMemo(() => {
    const entries = Object.values(presence ?? {}).filter(
      (entry) => entry?.user?.id
    )
    return entries.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  }, [presence])

  const persistDoc = (nextText, timestamp = Date.now()) => {
    lastUpdateRef.current = timestamp
    setDocState({ text: nextText, updatedAt: timestamp })
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ text: nextText, updatedAt: timestamp })
    )
  }

  const upsertPresence = useCallback(
    (userId, entryOrUpdater) => {
      if (!userId) return
      setPresence((prev) => {
        const next = { ...prev }

        if (entryOrUpdater === null) {
          delete next[userId]
        } else {
          const source =
            typeof entryOrUpdater === 'function'
              ? entryOrUpdater(prev[userId])
              : entryOrUpdater

          if (!source) {
            delete next[userId]
          } else {
            next[userId] = {
              ...prev[userId],
              ...source,
            }
          }
        }

        const pruned = prunePresenceSnapshot(next)
        persistPresenceSnapshot(presenceStorageKey, pruned)
        return pruned
      })
    },
    [presenceStorageKey]
  )

  const handlePresenceMessage = useCallback((payload) => {
    const { user, action, cursor } = payload
    if (!user?.id) return

    if (action === 'leave') {
      upsertPresence(user.id, null)
      return
    }

    upsertPresence(user.id, (previousEntry) => ({
      user,
      cursor: cursor ?? previousEntry?.cursor,
      lastSeen: Date.now(),
    }))
  }, [upsertPresence])

  useEffect(() => {
    document.title = `Room ${roomId} | Collab`
    return () => {
      document.title = 'Room Lobby'
    }
  }, [roomId])

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key !== storageKey || !event.newValue) return
      try {
        const payload = JSON.parse(event.newValue)
        if (
          typeof payload.text === 'string' &&
          typeof payload.updatedAt === 'number' &&
          payload.updatedAt > lastUpdateRef.current
        ) {
          persistDoc(payload.text, payload.updatedAt)
        }
      } catch {
        // ignore malformed payloads
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [storageKey])

  useEffect(() => {
    const handlePresenceStorage = (event) => {
      if (event.key !== presenceStorageKey || !event.newValue) return
      try {
        const snapshot = JSON.parse(event.newValue) || {}
        setPresence(prunePresenceSnapshot(snapshot))
      } catch {
        // ignore malformed payloads
      }
    }

    window.addEventListener('storage', handlePresenceStorage)
    return () => window.removeEventListener('storage', handlePresenceStorage)
  }, [presenceStorageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const intervalId = window.setInterval(() => {
      setPresence((prev) => {
        const pruned = prunePresenceSnapshot(prev)
        if (Object.keys(prev).length === Object.keys(pruned).length) {
          return prev
        }
        persistPresenceSnapshot(presenceStorageKey, pruned)
        return pruned
      })
    }, PRESENCE_TTL_MS)

    return () => window.clearInterval(intervalId)
  }, [presenceStorageKey])

  useEffect(() => {
    try {
      const channel = new BroadcastChannel(`room-channel:${roomId}`)
      channelRef.current = channel
      setIsChannelReady(true)
      channel.onmessage = (event) => {
        const payload = event?.data
        if (!payload) return

        if (payload.type === 'presence') {
          handlePresenceMessage(payload)
          return
        }

        const message = payload.type === 'doc' ? payload : null
        const textPayload = message ?? payload

        if (
          typeof textPayload?.text === 'string' &&
          typeof textPayload?.updatedAt === 'number' &&
          textPayload.updatedAt > lastUpdateRef.current
        ) {
          persistDoc(textPayload.text, textPayload.updatedAt)
        }
      }

      return () => {
        setIsChannelReady(false)
        channel.close()
      }
    } catch (error) {
      setIsChannelReady(false)
      console.warn(
        'BroadcastChannel unavailable; falling back to storage.',
        error
      )
    }
  }, [roomId, handlePresenceMessage])

  useEffect(() => {
    if (!currentUser) return
    upsertPresence(currentUser.id, {
      user: currentUser,
      lastSeen: Date.now(),
    })
  }, [currentUser, upsertPresence])

  useEffect(() => {
    if (!currentUser || !isChannelReady) return

    const announceJoin = () => {
      channelRef.current?.postMessage({
        type: 'presence',
        action: 'join',
        user: currentUser,
      })
      upsertPresence(currentUser.id, {
        user: currentUser,
        lastSeen: Date.now(),
      })
    }

    announceJoin()

    const handleBeforeUnload = () => {
      channelRef.current?.postMessage({
        type: 'presence',
        action: 'leave',
        user: currentUser,
      })
      removeUserFromPresenceSnapshot(presenceStorageKey, currentUser.id)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      channelRef.current?.postMessage({
        type: 'presence',
        action: 'leave',
        user: currentUser,
      })
      removeUserFromPresenceSnapshot(presenceStorageKey, currentUser.id)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [currentUser, isChannelReady, presenceStorageKey, upsertPresence])

  const broadcastCursor = useCallback(() => {
    if (!currentUser || !isChannelReady || !editorRef.current) return

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const anchorNode = selection.anchorNode
    if (!editorRef.current.contains(anchorNode)) return

    const range = selection.getRangeAt(0).cloneRange()
    range.collapse(true)
    const rangeRect = range.getClientRects()[0] ?? range.getBoundingClientRect()
    if (!rangeRect) return

    const editorRect = editorRef.current.getBoundingClientRect()
    const coords = {
      x: rangeRect.left - editorRect.left + editorRef.current.scrollLeft,
      y: rangeRect.top - editorRect.top + editorRef.current.scrollTop,
    }

    const cursorPayload = {
      type: 'presence',
      action: 'cursor',
      user: currentUser,
      cursor: {
        ...coords,
        updatedAt: Date.now(),
      },
    }

    upsertPresence(currentUser.id, {
      user: currentUser,
      cursor: cursorPayload.cursor,
      lastSeen: Date.now(),
    })

    channelRef.current?.postMessage(cursorPayload)
  }, [currentUser, isChannelReady, upsertPresence])

  useEffect(() => {
    const handleSelectionChange = () => {
      broadcastCursor()
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange)
  }, [broadcastCursor])

  const handleInput = () => {
    if (!editorRef.current) return
    const nextText = editorRef.current.innerText
    const timestamp = Date.now()
    persistDoc(nextText, timestamp)
    channelRef.current?.postMessage({
      type: 'doc',
      text: nextText,
      updatedAt: timestamp,
    })
    broadcastCursor()
  }

  const handleCopyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
    } catch {
      alert('Unable to copy. Please copy the Room ID manually.')
    }
  }

  const handleCopyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(buildRoomUrl(roomId))
    } catch {
      alert('Unable to copy the share link. Please copy the URL manually.')
    }
  }

  useEffect(() => {
    if (!editorRef.current) return
    if (editorRef.current.innerText === text) return
    editorRef.current.innerText = text
  }, [text])

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto flex max-w-5xl flex-col space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Collaborative room
            </p>
            <p className="font-mono text-sm text-slate-800">{roomId}</p>
            <p className="text-xs text-slate-500">
              Last synced {new Date(updatedAt).toLocaleTimeString()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleCopyRoomId}
              className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              type="button"
            >
              Copy Room ID
            </button>
            <button
              onClick={handleCopyShareLink}
              className="rounded border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-600 hover:bg-indigo-100"
              type="button"
            >
              Share Link
            </button>
            <button
              onClick={onExit}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
              type="button"
            >
              Back to Lobby
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
          <span className="text-xs uppercase tracking-wide text-slate-400">
            Active
          </span>
          {presenceList.length === 0 && (
            <span className="text-slate-400">Waiting for collaborators...</span>
          )}
          {presenceList.map(({ user }) => (
            <span
              key={user.id}
              className="inline-flex items-center space-x-2 rounded-full border border-slate-100 px-3 py-1"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: user.color || '#94a3b8' }}
              />
              <span className="text-slate-700">{user.name}</span>
            </span>
          ))}
        </div>

        <section className="relative rounded-xl border border-slate-200 bg-white shadow">
          <div
            ref={editorRef}
            contentEditable
            spellCheck={false}
            onInput={handleInput}
            onKeyUp={broadcastCursor}
            onMouseUp={broadcastCursor}
            onFocus={broadcastCursor}
            className="editor-scrollbar h-[70vh] w-full overflow-auto rounded-xl p-4 font-mono text-sm text-slate-800 focus:outline-none"
            suppressContentEditableWarning
          />
          <div className="pointer-events-none absolute inset-0">
            {presenceList
              .filter(({ user }) => user.id !== currentUser?.id)
              .map(({ user, cursor }) => {
                if (!cursor) return null
                return (
                  <div
                    key={user.id}
                    className="absolute flex transform transition-transform duration-75"
                    style={{
                      transform: `translate(${cursor.x}px, ${cursor.y}px)`,
                    }}
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className="rounded px-2 py-0.5 text-[10px] font-semibold text-white shadow"
                        style={{ backgroundColor: user.color || '#0f172a' }}
                      >
                        {getInitials(user.name)}
                      </span>
                      <span
                        className="mt-1 h-4 w-1 rounded-b-full"
                        style={{ backgroundColor: user.color || '#0f172a' }}
                      />
                    </div>
                  </div>
                )
              })}
          </div>
        </section>

        <p className="text-xs text-right text-slate-500">
          Availability-first sync: last writer wins when peers reconnect.
        </p>
      </div>
    </div>
  )
}

const IdentityPrompt = ({ roomId, onConfirm, onCancel }) => {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Please share your display name to join collaborators.')
      return
    }
    setError('')
    onConfirm(trimmed)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Joining Room
        </p>
        <p className="font-mono text-sm text-slate-800">{roomId}</p>
        <div>
          <label className="text-sm font-medium text-slate-700">
            Display Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="e.g. Alex P."
            autoFocus
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end space-x-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            Join Room
          </button>
        </div>
      </form>
    </div>
  )
}

function App() {
  const initialUser = useMemo(() => readCurrentUserFromStorage(), [])
  const [showCreateRoomForm, setShowCreateRoomForm] = useState(false)
  const [name, setName] = useState('')
  const [rooms, setRooms] = useState(() => readRoomsFromStorage())
  const [roomIdInput, setRoomIdInput] = useState('')
  const [joinName, setJoinName] = useState(initialUser?.name ?? '')
  const [challenge, setChallenge] = useState(generateChallenge)
  const [challengeAnswer, setChallengeAnswer] = useState('')
  const [formError, setFormError] = useState('')
  const [currentUser, setCurrentUser] = useState(initialUser)
  const [currentRoomId, setCurrentRoomId] = useState(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    return params.get('roomId')
  })

  const ensureCurrentUser = useCallback(
    (displayName, preferredId) => {
      const trimmed = displayName?.trim()
      if (!trimmed) return null

      if (currentUser && currentUser.name === trimmed) {
        const profile =
          preferredId && preferredId !== currentUser.id
            ? { ...currentUser, id: preferredId }
            : { ...currentUser }
        if (!profile.color) {
          profile.color = generateUserColor()
        }
        setCurrentUser(profile)
        persistCurrentUser(profile)
        return profile
      }

      const profile = {
        id: preferredId ?? generateTempId(),
        name: trimmed,
        color: generateUserColor(),
      }
      setCurrentUser(profile)
      persistCurrentUser(profile)
      return profile
    },
    [currentUser]
  )

  const clearRoomFromUrl = useCallback(() => {
    if (typeof window === 'undefined') return false
    const url = new URL(window.location.href)
    const hadRoomId = url.searchParams.has('roomId')
    if (hadRoomId) {
      url.searchParams.delete('roomId')
      window.history.replaceState({}, '', url)
    }
    return hadRoomId
  }, [])

  const exitRoom = useCallback(() => {
    const removedParam = clearRoomFromUrl()
    setCurrentRoomId(null)

    if (typeof window !== 'undefined') {
      if (window.history.length <= 1) {
        window.close()
      }

      if (removedParam && window.location.search.includes('roomId')) {
        const fallbackUrl = new URL(window.location.href)
        fallbackUrl.searchParams.delete('roomId')
        window.location.replace(fallbackUrl.toString())
      }
    }
  }, [clearRoomFromUrl])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(rooms))
  }, [rooms])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handleStorage = (event) => {
      if (event.key !== ROOM_STORAGE_KEY || !event.newValue) return
      try {
        const payload = JSON.parse(event.newValue)
        if (Array.isArray(payload)) {
          setRooms(payload)
        }
      } catch {
        // ignore malformed payloads
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search)
      setCurrentRoomId(params.get('roomId'))
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  if (currentRoomId) {
    if (!currentUser) {
      return (
        <IdentityPrompt
          roomId={currentRoomId}
          onConfirm={(displayName) => {
            const profile = ensureCurrentUser(displayName)
            if (profile) {
              setJoinName(profile.name)
            }
          }}
          onCancel={exitRoom}
        />
      )
    }

    return (
      <CollaborativeWorkspace
        roomId={currentRoomId}
        currentUser={currentUser}
        onExit={exitRoom}
      />
    )
  }

  const handleCreateRoomClick = () => {
    setShowCreateRoomForm(true)
    setFormError('')
    setName('')
    setChallengeAnswer('')
    setChallenge(generateChallenge())
  }

  const handleCreateRoomSubmit = (event) => {
    event.preventDefault()
    const trimmedName = name.trim()

    if (!trimmedName) {
      setFormError('Please provide your name.')
      return
    }

    if (Number(challengeAnswer) !== challenge.answer) {
      setFormError('Human check failed. Please try again.')
      setChallenge(generateChallenge())
      setChallengeAnswer('')
      return
    }

    const creatorId = generateTempId()
    const roomId = generateRoomId()
    const profile = ensureCurrentUser(trimmedName, creatorId)
    if (!profile) {
      setFormError('Unable to confirm your identity. Please try again.')
      return
    }
    setJoinName(profile.name)
    setRooms((prev) => [
      ...prev,
      { owner: trimmedName, creatorId, roomId, createdAt: Date.now() },
    ])
    setShowCreateRoomForm(false)
    setFormError('')
    setName('')
    setChallengeAnswer('')

    openCollaborativeWindow(roomId)
    alert(
      `Room created for ${trimmedName}\nShare this room ID: ${roomId}\nOwner temp ID: ${creatorId}`
    )
  }

  const handleEnterRoom = () => {
    const trimmedRoomId = roomIdInput.trim()
    if (!trimmedRoomId) {
      alert('Please enter a Room ID')
      return
    }

    const collaboratorName = (joinName || currentUser?.name || '').trim()
    if (!collaboratorName) {
      alert('Share your display name so others can see you in the document.')
      return
    }

    const participant = ensureCurrentUser(
      collaboratorName,
      currentUser?.id ?? undefined
    )
    if (!participant) return
    setJoinName(participant.name)

    const opened = openCollaborativeWindow(trimmedRoomId)
    if (!opened) {
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.set('roomId', trimmedRoomId)
        window.history.pushState({}, '', url)
      }
      setCurrentRoomId(trimmedRoomId)
      return
    }

    const matchingRoom = rooms.find((room) => room.roomId === trimmedRoomId)
    if (matchingRoom) {
      alert(
        `Connecting to room ${trimmedRoomId}, created by ${matchingRoom.owner}. Happy collaborating!`
      )
    } else {
      alert(
        'Room opened in a new window. If others are already writing there, the notes will sync shortly.'
      )
    }

    setRoomIdInput('')
  }

  return (
    <>
      <h1 className="text-3xl font-bold underline">Hello World</h1>
      <div className="mt-8 flex flex-col items-center space-y-4">
        <button
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
          onClick={handleCreateRoomClick}
        >
          Create Room
        </button>

        {showCreateRoomForm && (
          <form
            onSubmit={handleCreateRoomSubmit}
            className="w-full max-w-md space-y-4 rounded border border-gray-200 bg-white p-4 shadow"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Your Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Enter your name"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Human Verification
              </label>
              <p className="text-sm text-gray-500">
                What is {challenge.first} + {challenge.second}?
              </p>
              <input
                type="number"
                value={challengeAnswer}
                onChange={(event) => setChallengeAnswer(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Enter the sum"
              />
            </div>

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setShowCreateRoomForm(false)}
                className="rounded border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                Submit
              </button>
            </div>
          </form>
        )}

        <div className="w-full max-w-md space-y-4 rounded border border-gray-200 bg-white p-4 shadow">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Your Display Name
            </label>
            <input
              type="text"
              value={joinName}
              onChange={(event) => setJoinName(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              placeholder="e.g. Jordan S."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Enter Room ID
            </label>
            <div className="mt-1 flex space-x-2">
              <input
                type="text"
                value={roomIdInput}
                onChange={(event) => setRoomIdInput(event.target.value)}
                className="flex-1 rounded border border-gray-300 px-3 py-2 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                placeholder="e.g. room-abc123"
              />
              <button
                className="rounded bg-green-600 px-4 py-2 text-white transition hover:bg-green-700"
                onClick={handleEnterRoom}
                type="button"
              >
                Join Room
              </button>
            </div>
          </div>
        </div>

        {rooms.length > 0 && (
          <div className="w-full max-w-md rounded border border-gray-200 bg-white p-4 shadow">
            <h2 className="text-lg font-semibold text-gray-800">
              Recently Created Rooms
            </h2>
            <ul className="mt-2 space-y-2 text-sm text-gray-700">
              {rooms.map((room) => (
                <li
                  key={room.roomId}
                  className="space-y-1 rounded bg-gray-50 px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-800">
                      {room.owner}
                    </span>
                    <span className="font-mono text-[11px] text-gray-500">
                      Owner ID: {room.creatorId}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Share Room ID:</span>
                    <span className="font-mono text-gray-800">
                      {room.roomId}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}

export default App
