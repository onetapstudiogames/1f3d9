export const PART_42_STAGE_NODES = `  function ensureStageNode(kind, id, factory) {
    const key = stageNodeKey(kind, id)
    if (liveStageNextNodeKeys) liveStageNextNodeKeys.add(key)
    const existing = liveStageNodes.get(key)
    if (existing) return existing
    const node = factory()
    node.dataset.stageNodeKey = key
    node.dataset.stageNodeKind = kind
    liveStageNodes.set(key, node)
    return node
  }

  // Step 2 seam: later stage lanes retrieve a persistent node by record key here.
  function stageNode(kind, id) {
    return liveStageNodes.get(stageNodeKey(kind, id)) || null
  }

  function retireStageNode(kind, id) {
    const key = stageNodeKey(kind, id)
    const node = liveStageNodes.get(key)
    if (!node) return
    for (const portrait of node.querySelectorAll('.entity-portrait')) {
      portraitObserver?.unobserve(portrait)
      observedPortraitShells.delete(portrait)
      pendingPortraitShells.delete(portrait)
    }
    node.remove()
    liveStageNodes.delete(key)
    liveStageNextNodeKeys?.delete(key)
    liveStageRetainedNodeKeys?.delete(key)
  }

  function retainStageNode(kind, id) {
    const key = stageNodeKey(kind, id)
    if (liveStageRetainedNodeKeys && liveStageNodes.has(key)) {
      liveStageRetainedNodeKeys.add(key)
    }
  }

  function retireAllStageNodes() {
    for (const key of [...liveStageNodes.keys()]) {
      const [kind, id] = key.split(':')
      retireStageNode(kind, id)
    }
    liveStageNextNodeKeys = null
    liveStageRetainedNodeKeys = null
  }

  function setStageTransform(node, position) {
    const currentFacing = Number(node.style.getPropertyValue('--facing')) === -1 ? -1 : 1
    const facing = position.facing === -1 || position.facing === 1
      ? position.facing
      : currentFacing
    const anchor = node.style.offsetPath
      ? 'route'
      : node.dataset.stageNodeKind === 'thing' ? 'thing' : 'resident'
    node.style.setProperty('--facing', String(facing))
    node.style.setProperty('--stage-x', String(position.x) + 'px')
    node.style.setProperty('--stage-y', String(position.y) + 'px')
    node.style.transform = stageTransform(position.x, position.y, anchor)
    if (Number.isFinite(position.destinationX) && Number.isFinite(position.destinationY)) {
      node.style.setProperty('--stage-destination-transform', stageTransform(
        position.destinationX, position.destinationY, anchor))
    } else {
      node.style.removeProperty('--stage-destination-transform')
    }
  }

  function beginStageNodeReconcile() {
    liveStageNextNodeKeys = new Set()
    liveStageRetainedNodeKeys = new Set()
  }

  function finishStageNodeReconcile(drawnKeys = null) {
    if (liveStageNextNodeKeys === null) return
    const attachedKeys = drawnKeys === null
      ? null
      : new Set(stageDrawnNodeKeys(drawnKeys))
    const nextKeys = new Set([...(attachedKeys === null
      ? liveStageNextNodeKeys
      : [...liveStageNextNodeKeys].filter(key => attachedKeys.has(key))),
      ...(liveStageRetainedNodeKeys || []),
    ])
    const diff = reconcileStageNodeKeys([...liveStageNodes.keys()], [...nextKeys])
    for (const key of diff.retire) {
      const [kind, id] = key.split(':')
      retireStageNode(kind, id)
    }
    liveStageNextNodeKeys = null
    liveStageRetainedNodeKeys = null
  }

  function drawnStageNodeKeys(root) {
    return stageDrawnNodeKeys([...root.querySelectorAll('[data-stage-node-key]')]
      .map(node => node.dataset.stageNodeKey)
      .filter(Boolean))
  }

  function reconcileStageChildren(parent, children) {
    const next = new Set(children)
    for (const child of [...parent.children]) {
      if (!next.has(child)) child.remove()
    }
    for (const child of children) parent.append(child)
  }

`
