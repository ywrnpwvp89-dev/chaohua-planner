const $ = selector => document.querySelector(selector)
const storageKey = 'chaohua-planner-v1'
const demoTopic = '王橹杰超话'
const demoLink = 'https://weibo.com/p/1008080587fa0e8198ad45108f3a0ef6e08d3a'
const statusLabels = { todo: '待完成', verify: '待本人验证', done: '已完成' }
const taskTitles = { 签到: '超话签到', 评论: '读帖与评论', 转发: '转发想分享的帖子', 发帖: '准备一条超话帖子' }
const syncLabels = { topic: '仅发超话', home: '同步微博主页' }
const editor = $('#editor')
const taskForm = $('#task-form')
const settingsForm = $('#settings-form')
const planForm = $('#plan-form')
const planEditor = $('#plan-editor')
const guideEditor = $('#guide-editor')
const importFile = $('#import-data')
let editingId
let messageTimer

function dateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [date.getFullYear(), month, day].join('-')
}

function makeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function newTask(kind, day, account, id = makeId()) {
  return {
    id,
    title: taskTitles[kind],
    kind,
    day,
    time: '',
    draft: '',
    link: '',
    account,
    status: 'todo'
  }
}

function initialState() {
  return {
    version: 2,
    topic: demoTopic,
    link: demoLink,
    accounts: [],
    tasks: Object.keys(taskTitles).map(kind => newTask(kind, dateKey(), '', 'example-' + kind))
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey))
    if (!saved) return initialState()
    if (saved.version === 2) return saved
    const migrated = { ...saved, version: 2 }
    if (saved.topic === '何灵超话' && !saved.link) {
      migrated.topic = demoTopic
      migrated.link = demoLink
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(migrated))
    } catch {
      // Keep saved tasks usable when the browser permits reading but blocks writes.
    }
    return migrated
  } catch {
    return initialState()
  }
}

let state = load()
let hasSavedState
try {
  hasSavedState = localStorage.getItem(storageKey) !== null
} catch {
  hasSavedState = false
}

function notify(message) {
  const toast = $('#message')
  toast.textContent = message
  toast.hidden = false
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => { toast.hidden = true }, 4500)
}

function commit(next, message) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    notify('当前浏览器无法保存记录。请用正常浏览窗口打开原型。')
    return false
  }
  state = next
  hasSavedState = true
  render()
  if (message) notify(message)
  return true
}

function weiboLink(value) {
  try {
    const url = new URL(value.trim())
    const isWeibo = ['weibo.com', 'weibo.cn', 't.cn'].some(
      domain => url.hostname === domain || url.hostname.endsWith('.' + domain)
    )
    return url.protocol === 'https:' && isWeibo && !url.username && !url.password && !url.port
      ? url.href
      : ''
  } catch {
    return ''
  }
}

function weiboAnchor(label, href) {
  const link = element('a', label, 'action-link')
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function readLink(field) {
  const input = field.value.trim()
  const link = weiboLink(input)
  if (input && !link) {
    field.setCustomValidity('请输入微博客户端复制的 HTTPS 链接。')
    field.reportValidity()
    return null
  }
  return link
}

function searchLink() {
  return 'https://s.weibo.com/weibo?q=' + encodeURIComponent(state.topic)
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}

function button(label, action, className = 'secondary') {
  const node = element('button', label, className)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

function updateTask(id, changes) {
  return commit({
    ...state,
    tasks: state.tasks.map(task => task.id === id ? { ...task, ...changes } : task)
  }, '已保存')
}

function setStatus(task, status) {
  if (updateTask(task.id, { status })) {
    const activePage = document.querySelector('nav [aria-current]').dataset.page
    const section = document.getElementById(activePage)
    const replacement = [...section.querySelectorAll('[data-task]')].find(card => card.dataset.task === task.id)
    const fallback = activePage === 'tasks' ? $('#filter') : section.querySelector('[data-plan]')
    const control = replacement?.querySelector('select') ?? fallback
    control.focus()
  }
}

async function copyDraft(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      notify('草稿已复制')
      return
    }
  } catch {
    // Continue with the fallback available on a local HTTP preview.
  }
  const selected = element('textarea')
  selected.value = text
  selected.readOnly = true
  selected.style.position = 'fixed'
  selected.style.opacity = '0'
  const container = document.querySelector('dialog[open]') || document.body
  const focused = document.activeElement
  container.append(selected)
  selected.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    // If automatic copying fails, the draft stays selectable on the card.
  } finally {
    selected.remove()
    focused?.focus()
  }
  notify(copied ? '草稿已复制' : '可在任务卡片内选中草稿复制。')
}

function calendarText(value) {
  return value.replace(/[\\,;]/g, '\\$&').replace(/\r?\n|\r/g, '\\n')
}

function foldCalendarLine(line) {
  const encoder = new TextEncoder()
  let size = 0
  let result = ''
  for (const char of line) {
    const length = encoder.encode(char).length
    if (size + length > 75) {
      result += '\r\n '
      size = 1
    }
    result += char
    size += length
  }
  return result
}

function downloadFile(name, type, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = element('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function downloadReminder(task) {
  const start = new Date(task.day + 'T' + task.time)
  const utcStamp = date => date.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Chaohua Planner//Reminder//ZH',
    'BEGIN:VEVENT', 'UID:' + encodeURIComponent(task.id) + '@chaohua.local',
    'DTSTAMP:' + utcStamp(new Date()), 'DTSTART:' + utcStamp(start),
    'SUMMARY:' + calendarText(task.title), 'DESCRIPTION:' + calendarText(state.topic),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S',
    'DESCRIPTION:' + calendarText(task.title), 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'
  ]
  downloadFile('超话日程-' + task.day + '.ics', 'text/calendar;charset=utf-8', lines.map(foldCalendarLine).join('\r\n') + '\r\n')
  notify('日历文件已生成，导入日历后生效。')
}

function taskDetails(task, compact = false) {
  const account = state.accounts.find(item => item.id === task.account)
  const detail = element('div', '', 'card-detail')
  detail.append(element('h3', task.title))
  const meta = compact ? [account?.alias, syncLabels[task.syncPreference]] :
    [task.kind, task.day, task.time, account?.alias, syncLabels[task.syncPreference]]
  if (meta.some(Boolean)) detail.append(element('p', meta.filter(Boolean).join(' · '), 'meta'))
  if (task.draft) detail.append(element('p', task.draft, 'draft'))
  return detail
}

function openTaskLink(task) {
  const target = weiboLink(task.link) || weiboLink(state.link)
  return weiboAnchor(target ? '打开微博' : '搜索超话', target || searchLink())
}

function taskCard(task) {
  const actions = element('div', '', 'card-actions')
  const select = element('select')
  select.setAttribute('aria-label', task.title + '的状态')
  for (const [value, label] of Object.entries(statusLabels)) select.add(new Option(label, value))
  select.value = task.status
  select.addEventListener('change', () => {
    const requested = select.value
    select.value = task.status
    setStatus(task, requested)
  })

  actions.append(openTaskLink(task), select, button('编辑', () => openEditor(task)))
  const result = weiboLink(task.resultLink)
  if (result) actions.append(weiboAnchor('打开完成记录', result))
  if (task.draft && ['评论', '发帖'].includes(task.kind)) actions.append(button('复制草稿', () => copyDraft(task.draft)))
  if (task.time) actions.append(button('下载日历提醒', () => downloadReminder(task)))
  const card = element('article', '', 'card')
  card.dataset.task = task.id
  card.append(taskDetails(task), element('span', statusLabels[task.status], 'badge ' + task.status), actions)
  return card
}

function renderGuide(today) {
  const next = today.find(task => task.status === 'todo')
  const blocked = today.filter(task => task.status === 'verify').length
  const guide = $('#today-guide')
  guide.hidden = today.length === 0
  const context = element('div')
  const title = next ? '下一项 · ' + next.title : '今日待办已处理'
  context.append(element('strong', title))
  if (blocked) context.append(element('p', blocked + ' 项待本人验证'))
  guide.replaceChildren(context)
  if (next) guide.append(button('继续任务', () => {
    guideEditor.showModal()
    renderTasks()
    $('#guide-content a')?.focus()
  }, 'primary'))

  if (!guideEditor.open) return
  const container = $('#guide-content')
  if (!next) {
    const message = blocked ? '普通待办已处理，可在今日任务里查看待本人验证的事项。' : '今天的待办都已完成。'
    container.replaceChildren(element('p', message))
    $('#close-guide').focus()
    return
  }
  const actions = element('div', '', 'card-actions')
  actions.append(
    openTaskLink(next),
    button('记为完成', () => updateTask(next.id, { status: 'done' }), 'primary'),
    button('待本人验证', () => updateTask(next.id, { status: 'verify' }))
  )
  if (next.draft && ['评论', '发帖'].includes(next.kind)) actions.append(button('复制草稿', () => copyDraft(next.draft)))
  const card = element('div', '', 'card')
  card.append(taskDetails(next, true), actions)
  const focused = container.contains(document.activeElement)
  container.replaceChildren(card)
  if (focused) actions.querySelector('a').focus()
}

function renderWeek(now) {
  const start = new Date(now)
  start.setDate(start.getDate() - 6)
  const startDay = dateKey(start)
  const endDay = dateKey(now)
  const tasks = state.tasks.filter(task => task.day >= startDay && task.day <= endDay)
  const done = tasks.filter(task => task.status === 'done')
  const byAlias = new Map()
  const aliases = new Map(state.accounts.map(account => [account.id, account.alias]))
  for (const task of tasks) {
    const alias = aliases.get(task.account) || '未指定'
    const tally = byAlias.get(alias) || { done: 0, total: 0 }
    tally.total++
    if (task.status === 'done') tally.done++
    byAlias.set(alias, tally)
  }
  const counts = [...byAlias].map(([alias, tally]) => alias + ' ' + tally.done + '/' + tally.total)
  const summary = $('#week-summary')
  summary.replaceChildren(
    element('span', '已记录完成 ' + done.length + ' / ' + tasks.length + ' 项，按任务计划日期统计。')
  )
  if (counts.length > 1 || (counts.length === 1 && state.accounts.length)) {
    for (const count of counts) summary.append(element('span', count, 'week-alias'))
  }
  $('#week-link').href = weiboLink(state.link) || searchLink()
}

function renderTasks() {
  const now = new Date()
  const day = dateKey(now)
  const today = state.tasks.filter(task => task.day === day)
  const count = status => today.filter(task => task.status === status).length
  const done = count('done')
  const label = $('#today-label')
  label.dateTime = day
  label.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now)
  document.title = state.topic + ' · 超话日程'
  $('#topic').textContent = state.topic
  $('#topic-link').textContent = weiboLink(state.link) ? '打开超话主页' : '搜索' + state.topic
  $('#topic-link').href = weiboLink(state.link) || searchLink()
  $('#progress-count').textContent = done + '/' + today.length
  $('#progress-ring').style.setProperty('--progress', (today.length ? 100 * done / today.length : 0) + '%')
  $('#summary').replaceChildren(...Object.entries(statusLabels).map(([status, title]) => {
    const tile = element('div', title)
    tile.append(element('strong', String(count(status))))
    return tile
  }))
  renderGuide(today)
  renderWeek(now)
  $('#home-list').replaceChildren(...(today.length ? today.map(taskCard) : [element('p', '今天没有任务。', 'panel')]))
  const filter = $('#filter').value
  const tasks = state.tasks.filter(task => !filter || task.status === filter)
    .sort((left, right) => left.day.localeCompare(right.day) || left.time.localeCompare(right.time))
  $('#task-list').replaceChildren(...(tasks.length ? tasks.map(taskCard) : [element('p', '当前没有符合条件的任务。', 'panel')]))
}

function render() {
  renderTasks()
  $('#account-list').replaceChildren(...state.accounts.map(account => {
    const detail = element('div', '', 'card-detail')
    detail.append(element('h3', account.alias), element('p', account.group || '未分组', 'meta'))
    const remove = button('移除', () => {
      if (window.confirm('移除这个别名？已建任务会保留，归属清空。')) {
        commit({
          ...state,
          accounts: state.accounts.filter(item => item.id !== account.id),
          tasks: state.tasks.map(task => task.account === account.id ? { ...task, account: '' } : task)
        }, '已移除别名')
      }
    })
    const card = element('article', '', 'card')
    card.append(detail, remove)
    return card
  }))
}

function fillAccounts(field) {
  field.replaceChildren(new Option('未指定', ''), ...state.accounts.map(account => new Option(account.alias, account.id)))
}

function openPlan() {
  planForm.reset()
  fillAccounts(planForm.elements.account)
  planForm.elements.day.value = dateKey()
  $('#plan-error').textContent = ''
  planEditor.showModal()
}

planForm.addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(planForm)
  const day = data.get('day')
  const account = data.get('account')
  const kinds = data.getAll('kinds')
  if (!kinds.length) {
    $('#plan-error').textContent = '至少选择一项任务。'
    return
  }
  const tasks = hasSavedState ? state.tasks : []
  const existing = new Set(tasks
    .filter(task => task.day === day && task.account === account)
    .map(task => task.kind))
  const added = kinds.filter(kind => !existing.has(kind)).map(kind => newTask(kind, day, account))
  if (!added.length) {
    $('#plan-error').textContent = '这个日期和账号已包含所选任务。'
    return
  }
  if (commit({ ...state, tasks: [...tasks, ...added] }, '已添加 ' + added.length + ' 项任务')) planEditor.close()
})

function openEditor(task) {
  editingId = task?.id
  taskForm.reset()
  const fields = taskForm.elements
  fields.link.setCustomValidity('')
  fields.resultLink.setCustomValidity('')
  fillAccounts(fields.account)
  fields.title.value = task?.title || ''
  fields.kind.value = task?.kind || '签到'
  $('#sync-field').hidden = fields.kind.value !== '发帖'
  fields.syncPreference.value = task?.syncPreference || 'default'
  fields.resultLink.value = task?.resultLink || ''
  fields.account.value = task?.account || ''
  fields.day.value = task?.day || dateKey()
  fields.time.value = task?.time || ''
  fields.link.value = task?.link || ''
  fields.draft.value = task?.draft || ''
  $('#editor-title').textContent = task ? '编辑任务' : '新建任务'
  $('#delete-task').hidden = !task
  editor.showModal()
}

document.querySelectorAll('nav [data-page]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== button.dataset.page })
    document.querySelectorAll('nav [data-page]').forEach(item => item.removeAttribute('aria-current'))
    button.setAttribute('aria-current', 'page')
    window.scrollTo(0, 0)
    renderTasks()
  })
})
document.querySelectorAll('[data-new]').forEach(button => button.addEventListener('click', () => openEditor()))
document.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', openPlan))
$('#close-plan').addEventListener('click', () => planEditor.close())
$('#close-guide').addEventListener('click', () => guideEditor.close())
guideEditor.addEventListener('close', () => {
  ($('#today-guide button') || $('#home [data-plan]')).focus()
})
taskForm.elements.kind.addEventListener('change', () => {
  $('#sync-field').hidden = taskForm.elements.kind.value !== '发帖'
})
$('#filter').addEventListener('change', renderTasks)
$('#close-editor').addEventListener('click', () => editor.close())
$('#delete-task').addEventListener('click', () => {
  if (window.confirm('删除这项任务？') &&
      commit({ ...state, tasks: state.tasks.filter(task => task.id !== editingId) }, '已删除任务')) editor.close()
})
for (const field of [taskForm.elements.link, taskForm.elements.resultLink, settingsForm.elements.link]) {
  field.addEventListener('input', () => field.setCustomValidity(''))
}
taskForm.addEventListener('submit', event => {
  event.preventDefault()
  const fields = taskForm.elements
  const title = fields.title.value.trim()
  const link = readLink(fields.link)
  if (link === null) return
  const resultLink = readLink(fields.resultLink)
  if (resultLink === null) return
  if (!title) {
    notify('请填写任务名称')
    return
  }
  const original = state.tasks.find(task => task.id === editingId)
  const task = {
    id: original?.id || makeId(),
    title,
    kind: fields.kind.value,
    day: fields.day.value,
    time: fields.time.value,
    link,
    resultLink,
    syncPreference: fields.kind.value === '发帖' ? fields.syncPreference.value : 'default',
    draft: fields.draft.value.trim(),
    account: fields.account.value,
    status: original?.status || 'todo'
  }
  const tasks = original
    ? state.tasks.map(item => item.id === task.id ? task : item)
    : [...state.tasks, task]
  if (commit({ ...state, tasks }, '任务已保存')) editor.close()
})
$('#account-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  const alias = form.elements.alias.value.trim()
  if (!alias) {
    notify('请填写账号别名')
    return
  }
  if (state.accounts.some(item => item.alias === alias)) {
    notify('这个别名已经存在')
    return
  }
  const account = { id: makeId(), alias, group: form.elements.group.value.trim() }
  if (commit({ ...state, accounts: [...state.accounts, account] }, '已添加账号别名')) form.reset()
})
settingsForm.elements.topic.value = state.topic
settingsForm.elements.link.value = state.link
settingsForm.addEventListener('submit', event => {
  event.preventDefault()
  const fields = settingsForm.elements
  const topic = fields.topic.value.trim()
  const link = readLink(fields.link)
  if (link === null) return
  if (!topic) {
    notify('请填写超话名称')
    return
  }
  commit({ ...state, topic, link }, '设置已保存')
})
$('#export-data').addEventListener('click', () => {
  try {
    const backup = window.ChaohuaTransfer.makeBackup(state)
    downloadFile('超话日程-' + dateKey() + '.json', 'application/json;charset=utf-8', backup)
    notify('已导出任务备份')
  } catch (error) {
    notify(error instanceof Error ? error.message : '无法导出备份。')
  }
})
$('#pick-import').addEventListener('click', () => importFile.click())
importFile.addEventListener('change', async () => {
  const [file] = importFile.files
  importFile.value = ''
  if (!file) return
  if (file.size > window.ChaohuaTransfer.maxBackupBytes) {
    notify('备份文件过大，最多 2 MB。')
    return
  }
  try {
    const text = await file.text()
    const current = hasSavedState ? state : { ...state, tasks: [] }
    const imported = window.ChaohuaTransfer.mergeBackup(current, text, weiboLink)
    if (!imported.addedTasks && !imported.addedAccounts) {
      notify('没有需要添加的记录。')
      return
    }
    if (!imported.addedTasks) imported.state.tasks = state.tasks
    commit(imported.state, '已导入 ' + imported.addedTasks + ' 项任务、' + imported.addedAccounts + ' 个别名')
  } catch (error) {
    notify(error instanceof Error ? error.message : '无法读取备份文件。')
  }
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderTasks()
})

render()
