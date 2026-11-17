import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import './App.css'

type SourceTab = 'url' | 'file' | 'obs'
type ProcessingStage = 'idle' | 'validating' | 'downloading' | 'analyzing' | 'choosing' | 'exporting' | 'complete' | 'error'

type Candidate = {
  id: number
  title: string
  time: string
  score: number
  reason: string
  color: string
  start?: number
  duration?: number
}

const initialCandidates: Candidate[] = [
  { id: 1, title: 'The clutch nobody expected', time: '02:14 - 02:48', score: 96, reason: 'Chat spike + excited speech', color: '#ff805d', start: 134, duration: 34 },
  { id: 2, title: 'That reaction was perfect', time: '04:06 - 04:32', score: 88, reason: 'Laughter + chat activity', color: '#7c83fd', start: 246, duration: 26 },
  { id: 3, title: 'A surprisingly useful tip', time: '07:51 - 08:27', score: 81, reason: 'High keyword relevance', color: '#4ecdc4', start: 471, duration: 36 },
]

const apiUrl = (path: string) => `${import.meta.env.DEV ? '' : 'http://127.0.0.1:8787'}${path}`

function App() {
  const [sourceTab, setSourceTab] = useState<SourceTab>('url')
  const [url, setUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [selectedId, setSelectedId] = useState(1)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [captionStyle, setCaptionStyle] = useState('Karaoke')
  const [captionsEnabled, setCaptionsEnabled] = useState(true)
  const [captionLanguage, setCaptionLanguage] = useState<'english' | 'hinglish'>('english')
  const [captionPosition, setCaptionPosition] = useState<'top' | 'middle' | 'bottom'>('bottom')
  const [activeTemplate, setActiveTemplate] = useState('Punchy')
  const [splitRatio, setSplitRatio] = useState(50)
  const [gameFocus, setGameFocus] = useState(50)
  const [faceFocus, setFaceFocus] = useState(50)
  const [trimOffset, setTrimOffset] = useState(0)
  const [trimDuration, setTrimDuration] = useState(30)
  const cropDrag = useRef<{ target: 'game' | 'face'; startX: number; startValue: number } | null>(null)
  const [status, setStatus] = useState('Ready for a video')
  const [processingStage, setProcessingStage] = useState<ProcessingStage>('idle')
  const [isExporting, setIsExporting] = useState(false)
  const [direction, setDirection] = useState('')
  const [candidates, setCandidates] = useState(initialCandidates)

  const selectedClip = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0],
    [candidates, selectedId],
  )

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setFileName(file.name)
      setSelectedFile(file)
      setPreviewUrl(URL.createObjectURL(file))
      setStatus(`${file.name} is ready to analyze`)
    }
  }

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    const moveCrop = (event: PointerEvent) => {
      if (!cropDrag.current) return
      const delta = ((event.clientX - cropDrag.current.startX) / 260) * 100
      const nextValue = Math.min(100, Math.max(0, cropDrag.current.startValue + delta))
      if (cropDrag.current.target === 'game') setGameFocus(Math.round(nextValue))
      else setFaceFocus(Math.round(nextValue))
    }
    const stopCrop = () => { cropDrag.current = null }
    window.addEventListener('pointermove', moveCrop)
    window.addEventListener('pointerup', stopCrop)
    return () => {
      window.removeEventListener('pointermove', moveCrop)
      window.removeEventListener('pointerup', stopCrop)
    }
  }, [])

  const startCropDrag = (target: 'game' | 'face', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    cropDrag.current = { target, startX: event.clientX, startValue: target === 'game' ? gameFocus : faceFocus }
  }

  const analyze = async () => {
    if (sourceTab === 'url' && !url.trim()) {
      setProcessingStage('error')
      setStatus('Paste a YouTube URL first')
      return
    }
    setIsAnalyzing(true)
    setProcessingStage('validating')
    setStatus('Validating your video source...')
    if (sourceTab === 'url' && url) {
      try {
        setProcessingStage('downloading')
        setStatus('Downloading the video locally...')
        const response = await fetch(apiUrl('/api/download'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        const result = await response.json() as { error?: string }
        if (!response.ok) throw new Error(result.error ?? 'Download failed')
        setProcessingStage('analyzing')
        setStatus(direction ? `Analyzing for: ${direction}` : 'Analyzing transcript and audio signals...')
        const analysisResponse = await fetch(apiUrl('/api/analyze'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction }),
        })
        const analysis = await analysisResponse.json() as { error?: string; candidates?: Omit<Candidate, 'color'>[] }
        if (!analysisResponse.ok || !analysis.candidates) throw new Error(analysis.error ?? 'Highlight analysis failed')
        setCandidates(analysis.candidates.map((candidate, index) => ({ ...candidate, color: ['#ff805d', '#7c83fd', '#4ecdc4'][index] ?? '#ff805d' })))
        setSelectedId(analysis.candidates[0]?.id ?? 1)
        setProcessingStage('choosing')
        setStatus(`${analysis.candidates.length} real highlights found`)
      } catch (error) {
        setProcessingStage('error')
        setStatus(error instanceof Error ? error.message : 'Could not download this video')
      } finally {
        setIsAnalyzing(false)
      }

      return
    }
    if (sourceTab === 'file' && selectedFile) {
      try {
        setProcessingStage('downloading')
        setStatus('Uploading your video locally...')
        const uploadResponse = await fetch(apiUrl('/api/upload'), {
          method: 'POST',
          headers: { 'Content-Type': selectedFile.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(selectedFile.name) },
          body: selectedFile,
        })
        const upload = await uploadResponse.json() as { error?: string }
        if (!uploadResponse.ok) throw new Error(upload.error ?? 'Upload failed')
        setProcessingStage('analyzing')
        setStatus(direction ? `Analyzing for: ${direction}` : 'Analyzing transcript and audio signals...')
        const analysisResponse = await fetch(apiUrl('/api/analyze'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction }),
        })
        const analysis = await analysisResponse.json() as { error?: string; candidates?: Omit<Candidate, 'color'>[] }
        if (!analysisResponse.ok || !analysis.candidates) throw new Error(analysis.error ?? 'Highlight analysis failed')
        setCandidates(analysis.candidates.map((candidate, index) => ({ ...candidate, color: ['#ff805d', '#7c83fd', '#4ecdc4'][index] ?? '#ff805d' })))
        setSelectedId(analysis.candidates[0]?.id ?? 1)
        setProcessingStage('choosing')
        setStatus(`${analysis.candidates.length} real highlights found`)
      } catch (error) {
        setProcessingStage('error')
        setStatus(error instanceof Error ? error.message : 'Could not process this file')
      } finally {
        setIsAnalyzing(false)
      }
      return
    }
    window.setTimeout(() => {
      setIsAnalyzing(false)
      setProcessingStage('choosing')
      setStatus('3 highlight candidates found')
    }, 1200)
  }

  const exportClip = async () => {
    setIsExporting(true)
    setProcessingStage('exporting')
    setStatus('Rendering a 9:16 MP4 with FFmpeg...')
    try {
      const response = await fetch(apiUrl('/api/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipId: selectedId, captions: captionsEnabled, language: captionLanguage, position: captionPosition, captionStyle, template: activeTemplate, splitRatio, gameFocus, faceFocus, trimOffset, trimDuration }),
      })
      const result = await response.json() as { error?: string; path?: string }
      if (!response.ok) throw new Error(result.error ?? 'Export failed')
      setProcessingStage('complete')
      setStatus(`${captionsEnabled ? 'Captioned' : 'Clean'} export complete: ${result.path?.split(/[\\/]/).pop() ?? 'MP4 ready'}`)
    } catch (error) {
      setProcessingStage('error')
      setStatus(error instanceof Error ? error.message : 'Could not export this clip')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">✦</span> clip<span>forge</span></div>
        <nav className="main-nav" aria-label="Primary navigation"><button className="nav-link active">Workspace</button><button className="nav-link">Exports</button><button className="nav-link">How it works</button></nav>
        <div className="topbar-actions">
          <span className="local-badge"><span className="status-dot" /> Local mode</span>
          <button className="icon-button" aria-label="Settings">⚙</button>
          <div className="avatar">A</div>
        </div>
      </header>

      <main>
        <div className="workflow-bar" aria-label="Workflow progress">
          <span className={`workflow-step ${processingStage !== 'idle' ? 'complete' : 'active'}`}><b>{processingStage !== 'idle' ? '✓' : '1'}</b> Add video</span><i />
          <span className={`workflow-step ${['analyzing', 'choosing', 'exporting', 'complete'].includes(processingStage) ? 'active' : ''}`}><b>2</b> Choose moments</span><i />
          <span className={`workflow-step ${['exporting', 'complete'].includes(processingStage) ? 'active' : ''}`}><b>3</b> Style &amp; export</span>
        </div>
        <section className="hero-section">
          <div>
            <p className="eyebrow">AI CLIP STUDIO <span>·</span> FREE &amp; LOCAL</p>
            <h1>What are we making<br /><em>today?</em></h1>
            <p className="hero-copy">Bring a video. Clipforge finds the moments worth sharing,<br />then helps you turn them into vertical clips.</p>
          </div>
          <div className="hero-shape"><div className="shape-card shape-back" /><div className="shape-card shape-front"><span>9:16</span><strong>YOUR<br />NEXT<br />CLIP</strong></div></div>
        </section>

        <section className="workspace-grid">
          <div className="panel source-panel">
            <div className="panel-heading">
              <div><p className="section-kicker">01 / SOURCE</p><h2>Bring in your video</h2></div>
              <span className="step-pill">Step 1 of 3</span>
            </div>
            <div className="source-tabs">
              {([['url', '↗', 'Video URL'], ['file', '↑', 'Upload file'], ['obs', '◉', 'OBS recording']] as const).map(([tab, icon, label]) => (
                <button key={tab} className={sourceTab === tab ? 'source-tab active' : 'source-tab'} onClick={() => setSourceTab(tab)}><span>{icon}</span>{label}</button>
              ))}
            </div>
            <div className="direction-field"><label htmlFor="direction">TELL CLIPFORGE WHAT TO FIND <span>OPTIONAL</span></label><div className="direction-input"><span>✦</span><input id="direction" value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="e.g. Find the funniest reactions or best advice..." /></div><div className="prompt-chips"><button onClick={() => setDirection('funniest reactions')}>Funniest moments</button><button onClick={() => setDirection('best advice')}>Best advice</button><button onClick={() => setDirection('big reactions')}>Big reactions</button></div></div>
            {sourceTab === 'url' && (
              <div className="input-row">
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a YouTube URL..." />
                <button className="small-action" onClick={() => setStatus(url ? 'URL is ready to analyze' : 'Paste a URL first')}>Add</button>
              </div>
            )}
            {sourceTab === 'file' && (
              <label className="dropzone"><span className="upload-icon">↑</span><strong>{fileName || 'Choose a video file'}</strong><small>MP4, MOV, MKV up to 4K</small><input type="file" accept="video/*" onChange={handleFile} /></label>
            )}
            {sourceTab === 'obs' && (
              <div className="obs-card"><span className="obs-icon">◉</span><div><strong>Watch your OBS recordings folder</strong><small>New recordings will appear here automatically.</small></div><button className="text-button">Choose folder</button></div>
            )}
            <div className="signal-list">
              <span className="signal-label">LOOK FOR</span>
              <span className="signal active">✦ Interesting speech</span><span className="signal active">◒ Audio peaks</span><span className="signal active">▣ Chat spikes</span>
            </div>
            <div className="processing-steps" aria-live="polite">
              <div className="processing-heading"><span>LIVE PROGRESS</span><small>{processingStage === 'error' ? 'Needs attention' : processingStage === 'complete' ? 'Finished' : 'Local processing'}</small></div>
              {([
                ['validating', '1', 'Validate source'],
                ['downloading', '2', 'Download video'],
                ['analyzing', '3', 'Analyze moments'],
                ['choosing', '4', 'Review highlights'],
                ['exporting', '5', 'Render final clip'],
              ] as const).map(([step, number, label]) => {
                const stageOrder = ['idle', 'validating', 'downloading', 'analyzing', 'choosing', 'exporting', 'complete']
                const currentOrder = stageOrder.indexOf(processingStage === 'error' ? 'idle' : processingStage)
                const stepOrder = stageOrder.indexOf(step)
                const isDone = processingStage === 'complete' || currentOrder > stepOrder
                const isCurrent = processingStage === step
                return <div className={`processing-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`} key={step}><b>{isDone ? '✓' : number}</b><span>{label}</span>{isCurrent && <i>working</i>}</div>
              })}
            </div>
            <div className="panel-footer"><span className="status-text"><span className="tiny-dot" /> {status}</span><button className="primary-button" onClick={analyze} disabled={isAnalyzing}>{isAnalyzing ? 'Analyzing...' : 'Find highlights'} <span>→</span></button></div>
          </div>

          <div className="panel highlights-panel">
            <div className="panel-heading">
              <div><p className="section-kicker">02 / HIGHLIGHTS</p><h2>Review suggestions</h2><p className="panel-help">Select a moment to preview and style it.</p></div>
              <span className="result-count">3 moments</span>
            </div>
            <div className="candidate-list">
              {candidates.map((candidate) => (
                <button className={candidate.id === selectedId ? 'candidate selected' : 'candidate'} key={candidate.id} onClick={() => { setSelectedId(candidate.id); setTrimOffset(0); setTrimDuration(candidate.duration ?? 30) }}>
                  <span className="candidate-thumb" style={{ background: candidate.color }}><span>▶</span></span>
                  <span className="candidate-info"><strong>{candidate.title}</strong><small>{candidate.time} · {candidate.reason}</small></span>
                  <span className="score"><small>match</small>{candidate.score}%</span>
                </button>
              ))}
            </div>
            <div className="confidence"><span>SELECTED MATCH</span><div className="confidence-bar"><i style={{ width: `${selectedClip.score}%` }} /></div><strong>{selectedClip.score}%</strong></div>
          </div>
        </section>

        <section className="panel editor-panel">
          <div className="panel-heading editor-heading">
            <div><p className="section-kicker">03 / STYLE &amp; EXPORT</p><h2>Make it yours</h2><p className="panel-help">Fine-tune the look, then export when it feels right.</p></div>
            <button className="export-button" onClick={exportClip} disabled={isExporting}>{isExporting ? 'Rendering...' : 'Export clip'} <span>↗</span></button>
          </div>
          <div className="editor-grid">
            <div className="preview-wrap"><div className={`phone-preview ${activeTemplate === 'Custom split' ? 'phone-preview-split' : ''}`}>{activeTemplate === 'Custom split' && <><div className="split-game" style={{ width: `${splitRatio}%` }}><span>GAMEPLAY</span></div><div className="split-face" style={{ width: `${100 - splitRatio}%` }}><span>STREAMER CAM</span></div><div className="split-divider" style={{ left: `${splitRatio}%` }} /></>}{previewUrl && activeTemplate !== 'Custom split' && <video className="source-video" src={previewUrl} muted controls preload="metadata" />}<div className="preview-overlay"><div className="preview-top"><span>LIVE</span><small>clipforge</small></div><div className="preview-content"><span className="preview-tag">HIGHLIGHT</span><strong>{selectedClip.title}</strong>{captionsEnabled && <div className={`preview-caption preview-caption-${captionPosition}`}>THIS IS<br /><b>THE MOMENT</b></div>}</div><div className="preview-controls"><span>↶</span><div><i /><i /><i /><i /><i /></div><span>↷</span></div></div></div></div>
            <div className="editor-controls">
              <div className="control-group"><label>TIMELINE <span className="control-note">ADJUST THIS CLIP</span></label><div className="timeline-track"><i style={{ left: `${Math.min(86, trimOffset * 2)}%`, width: `${Math.min(88, trimDuration * 2)}%` }} /></div><div className="timeline-values"><label>Start offset <input type="range" min="0" max="15" value={trimOffset} onChange={(event) => setTrimOffset(Number(event.target.value))} /><b>+{trimOffset}s</b></label><label>Duration <input type="range" min="5" max="60" value={trimDuration} onChange={(event) => setTrimDuration(Number(event.target.value))} /><b>{trimDuration}s</b></label></div></div>
              <div className="control-group"><label>CAPTIONS <span className="control-note">BURNED INTO VIDEO</span></label><div className="choice-row"><button className={captionsEnabled ? 'choice active' : 'choice'} onClick={() => setCaptionsEnabled(true)}>On</button><button className={!captionsEnabled ? 'choice active' : 'choice'} onClick={() => setCaptionsEnabled(false)}>Off</button></div></div>
              {captionsEnabled && <><div className="control-group"><label>CAPTION LANGUAGE</label><div className="choice-row"><button className={captionLanguage === 'english' ? 'choice active' : 'choice'} onClick={() => setCaptionLanguage('english')}>English</button><button className={captionLanguage === 'hinglish' ? 'choice active' : 'choice'} onClick={() => setCaptionLanguage('hinglish')}>Hinglish (Roman)</button></div></div><div className="control-group"><label>CAPTION POSITION</label><div className="choice-row">{(['top', 'middle', 'bottom'] as const).map((position) => <button key={position} className={captionPosition === position ? 'choice active' : 'choice'} onClick={() => setCaptionPosition(position)}>{position[0].toUpperCase() + position.slice(1)}</button>)}</div></div></>}
              <div className="control-group"><label>CAPTION STYLE</label><div className="choice-row">{['Karaoke', 'Clean', 'Bold'].map((style) => <button key={style} className={captionStyle === style ? 'choice active' : 'choice'} onClick={() => setCaptionStyle(style)}>{style}</button>)}</div></div>
              <div className="control-group"><label>TEMPLATE <span className="control-note">READY-TO-POST STYLES</span></label><div className="template-row">{['Punchy', 'Reaction', 'Neon', 'Chat pop', 'Custom split'].map((template, index) => <button key={template} className={activeTemplate === template ? 'template active' : 'template'} onClick={() => setActiveTemplate(template)}><span className={`template-art art-${index}`} />{template}</button>)}</div></div>
              {activeTemplate === 'Custom split' && <div className="custom-layout"><div className="custom-layout-heading"><div><strong>Custom split layout</strong><small>Drag each box over the part of the full video you want to keep.</small></div><span>LIVE EDIT</span></div><div className="crop-canvas">{previewUrl ? <video src={previewUrl} muted controls preload="metadata" /> : <div className="crop-placeholder"><span>FULL VIDEO PREVIEW</span><i /><i /><i /></div>}<div className="crop-box crop-box-game" style={{ left: `${gameFocus}%` }} onPointerDown={(event) => startCropDrag('game', event)}><b>GAMEPLAY</b><small>drag me</small></div><div className="crop-box crop-box-face" style={{ left: `${faceFocus}%` }} onPointerDown={(event) => startCropDrag('face', event)}><b>CAMERA</b><small>drag me</small></div></div><label className="split-control">Game width <input type="range" min="25" max="75" value={splitRatio} onChange={(event) => setSplitRatio(Number(event.target.value))} /><b>{splitRatio}%</b></label><div className="layout-hint">The boxes control the source crop. The width slider controls the final vertical split.</div></div>}
              <div className="control-group"><label>FORMAT</label><div className="format-row"><span className="format-icon">▯</span><div><strong>Vertical 9:16</strong><small>1080 × 1920 · MP4</small></div><span className="check">✓</span></div></div>
            </div>
          </div>
        </section>
      </main>
      <footer><span>clipforge is local-first. Your videos stay on your machine.</span><span>Built for creators who move fast <b>✦</b></span></footer>
    </div>
  )
}

export default App
