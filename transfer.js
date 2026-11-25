(() => {
  const backupVersion = 2
  const maxBackupBytes = 2 * 1024 * 1024
  const maxAccounts = 1000
  const maxTasks = 4000
  const accountFields = ['id', 'alias', 'group']
  const taskFields = ['id', 'title', 'kind', 'day', 'time', 'link', 'draft', 'account', 'status',
    'syncPreference', 'resultLink']
  const taskKinds = ['签到', '评论', '转发', '发帖']
  const taskStatuses = ['todo', 'verify', 'done']
  const syncPreferences = ['default', 'topic', 'home']

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function selectFields(record, fields) {
    return Object.fromEntries(fields.filter(field => Object.hasOwn(record, field))
      .map(field => [field, record[field]]))
  }

  function checkSize(text) {
    if (text.length > maxBackupBytes || new TextEncoder().encode(text).length > maxBackupBytes) {
      throw new Error('备份文件超过 2 MB。')
    }
  }

  function checkRecordCounts(accounts, tasks) {
    if (accounts.length > maxAccounts || tasks.length > maxTasks) {
      throw new Error('备份最多可包含 1000 个别名和 4000 条任务。')
    }
  }

  function makeBackup(state) {
    checkRecordCounts(state.accounts, state.tasks)
    const text = JSON.stringify({
      version: backupVersion,
      accounts: state.accounts.map(account => selectFields(account, accountFields)),
      tasks: state.tasks.map(task => selectFields(task, taskFields))
    }, null, 2)
    checkSize(text)
    return text
  }

  function validText(value, maxLength, required = false) {
    return typeof value === 'string' && value.length <= maxLength && (!required || value.trim() !== '')
  }

  function validId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_\u3400-\u9fff-]{1,96}$/.test(value)
  }

  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false
    const date = new Date(value + 'T00:00:00Z')
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
  }

  function readLink(value, validateLink) {
    if (value === '') return value
    if (!validText(value, 16384, true)) throw new Error('备份里有格式错误的微博链接。')
    const link = validateLink(value)
    if (typeof link !== 'string' || !link) throw new Error('备份里有格式错误的微博链接。')
    return link
  }

  function readAccount(account, index) {
    if (!isRecord(account) || !validId(account.id) ||
        !validText(account.alias, 30, true) || !validText(account.group, 30)) {
      throw new Error('备份中的第 ' + (index + 1) + ' 个账号别名格式有误。')
    }
    return selectFields(account, accountFields)
  }

  function readTask(task, index, validateLink) {
    if (!isRecord(task) || !validId(task.id) || !validText(task.title, 60, true) ||
        !taskKinds.includes(task.kind) || !validDay(task.day) ||
        typeof task.time !== 'string' || !/^(|(?:[01]\d|2[0-3]):[0-5]\d)$/.test(task.time) ||
        !validText(task.draft, 2500) || !(task.account === '' || validId(task.account)) ||
        !taskStatuses.includes(task.status) ||
        (Object.hasOwn(task, 'syncPreference') && !syncPreferences.includes(task.syncPreference))) {
      throw new Error('备份中的第 ' + (index + 1) + ' 条任务格式有误。')
    }
    const fields = selectFields(task, taskFields)
    fields.link = readLink(fields.link, validateLink)
    if (Object.hasOwn(fields, 'resultLink')) fields.resultLink = readLink(fields.resultLink, validateLink)
    return fields
  }

  function readBackup(jsonText, validateLink) {
    if (typeof jsonText !== 'string') throw new Error('请选择有效的 JSON 备份文件。')
    checkSize(jsonText)
    let backup
    try {
      backup = JSON.parse(jsonText.replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('无法读取此 JSON 备份文件。')
    }
    if (!isRecord(backup) || backup.version !== backupVersion ||
        !Array.isArray(backup.accounts) || !Array.isArray(backup.tasks)) {
      throw new Error('此文件不是支持的超话日程备份。')
    }
    checkRecordCounts(backup.accounts, backup.tasks)
    return {
      accounts: backup.accounts.map(readAccount),
      tasks: backup.tasks.map((task, index) => readTask(task, index, validateLink))
    }
  }

  function mergeBackup(currentState, jsonText, validateLink) {
    const backup = readBackup(jsonText, validateLink)
    const accounts = [...currentState.accounts]
    const tasks = [...currentState.tasks]
    const accountsById = new Map(accounts.map(account => [account.id, account]))
    const accountsByAlias = new Map(accounts.map(account => [account.alias, account]))
    const importedAccountIds = new Map()
    for (const account of backup.accounts) {
      if (importedAccountIds.has(account.id)) continue
      const existing = accountsById.get(account.id) ?? accountsByAlias.get(account.alias)
      if (existing) {
        importedAccountIds.set(account.id, existing.id)
        continue
      }
      accounts.push(account)
      accountsById.set(account.id, account)
      accountsByAlias.set(account.alias, account)
      importedAccountIds.set(account.id, account.id)
    }

    const taskIds = new Set(tasks.map(task => task.id))
    for (const task of backup.tasks) {
      if (taskIds.has(task.id)) continue
      const account = importedAccountIds.get(task.account) ?? accountsById.get(task.account)?.id ?? ''
      tasks.push({ ...task, account })
      taskIds.add(task.id)
    }

    checkRecordCounts(accounts, tasks)
    return {
      state: { ...currentState, accounts, tasks },
      addedTasks: tasks.length - currentState.tasks.length,
      addedAccounts: accounts.length - currentState.accounts.length
    }
  }

  window.ChaohuaTransfer = { makeBackup, mergeBackup, maxBackupBytes }
})()
