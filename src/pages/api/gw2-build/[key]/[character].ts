import { NextApiHandler, NextApiResponse } from 'next'
import fetch from 'isomorphic-fetch'
import subMinutes from 'date-fns/subMinutes'
import GuildWars2Build from '../../../../db/models/GuildWars2Build'
import { runMiddleware, cors } from '../../../../cors_middleware'

const logger = {
  start: (tag, ...args) => console.info(`[start:${tag}]`, ...args),
  end: (tag, ...args) => console.info(`[end:${tag}]`, ...args),
  do: (tag, ...args) => console.info(`[${tag}]`, ...args),
  warn: (msg) => console.warn('[warn]', msg),
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(() => resolve('fallback'), ms))

const handler: NextApiHandler = async (req, response) => {
  console.time('request')
  await runMiddleware(req, response, cors)
  try {
    const apiKey = (req.query.key || '').toString()
    const character = (req.query.character || '').toString()
    if (!apiKey) return
    const abortController = new AbortController()
    const getNormalPromise = getNormal(abortController, apiKey, character, response)
    const result = await Promise.race([getNormalPromise, wait(1_000 * 20)])
    if (result === 'fallback') {
      abortController.abort()
      await fallback(apiKey, character, response)
    }
  } catch (e) {
    logger.warn(e)
    response.status(500).json({ error: e.message })
  } finally {
    console.timeEnd('request')
  }
}

function prepareFetchItemsById(apiKey: string, abortController: AbortController) {
  return async (type: string, ids: any[]) => {
    if (ids.length === 0) return new Map()
    return fetch(`https://api.guildwars2.com/v2/${type}?access_token=${apiKey}&ids=${ids}`, {
      signal: abortController.signal,
    })
      .then((r) => r.json())
      .then((d) => new Map(d.map((i) => [i.id, i])))
  }
}

async function getNormal(
  abortController: AbortController,
  originalApiKey: string,
  character: string,
  response: NextApiResponse
) {
  try {
    const apiKey = encodeURIComponent(originalApiKey)
    const match = await GuildWars2Build.findOne({
      character,
      key: apiKey,
      lastUpdated: { $gte: subMinutes(new Date(), 30) },
    })
    if (match) {
      logger.do('cached')
      if (!abortController.signal.aborted) {
        response.setHeader('Cache-Control', 'max-age=300')
        response.json(match.data)
      }
      return
    }
    logger.start('character')
    console.time('character')
    const res = await fetch(`https://api.guildwars2.com/v2/characters?access_token=${apiKey}&ids=all`, {
      signal: abortController.signal,
    })
    if (res.ok) {
      const data = await res.json()
      logger.end('character')
      console.timeEnd('character')
      const characterData = data.find((d) => d.name === character) || data[0]
      if (!characterData) {
        throw new Error(`No characters found: Requested ${character}`)
      }
      const usedCharacter = characterData.name
      if (usedCharacter !== character) {
        logger.warn(`Using ${usedCharacter} instead of ${character}`)
      }
      delete characterData.recipes
      delete characterData.bags
      delete characterData.training
      delete characterData.backstory
      delete characterData.crafting

      if (!characterData.equipment) {
        logger.warn("Missing equipment, likely token didn't allow builds permission")
      }

      logger.do('skins')
      const skins = (characterData.equipment || []).map((item) => item?.skin).filter(Boolean)
      logger.do('skills')
      const skills = Object.values(characterData.skills || {})
        .flatMap((s: any) => [s.heal, s.elite, s.utilities])
        .filter(Boolean)
      logger.do('traits')
      const traits = Object.values(characterData.specializations || {}).flatMap((t: any) =>
        t.flatMap((item) => item?.traits)
      )
      logger.do('specializations')
      const specializations = Object.values(characterData.specializations || {})
        .flatMap((t: any) => t.flatMap((item) => item?.id))
        .filter(Boolean)
      logger.do('equipmentIds')
      const equipmentIds = [characterData?.equipment_pvp?.rune]
        .filter(Boolean)
        .concat(
          (characterData.equipment || [])
            .flatMap((item) => [item?.id, item?.upgrades, item?.infusions].filter(Boolean))
            .filter(Boolean)
        )

      console.info('[start:extra]')

      const itemFetcher = prepareFetchItemsById(apiKey, abortController)
      const [equipmentData, skinData, skillData, traitData, specializationData, amuletData] = await Promise.all([
        itemFetcher('items', equipmentIds),
        itemFetcher('skins', skins),
        itemFetcher('skills', skills),
        itemFetcher('traits', traits),
        itemFetcher('specializations', specializations),
        !characterData?.equipment_pvp?.amulet
          ? undefined
          : fetch(
              `https://api.guildwars2.com/v2/pvp/amulets?access_token=${apiKey}&id=${characterData.equipment_pvp.amulet}`,
              { signal: abortController.signal }
            ).then((r) => r.json()),
      ])
      const toStore = {
        equipmentData: [...equipmentData],
        skinData: [...skinData],
        skillData: [...skillData],
        traitData: [...traitData],
        specializationData: [...specializationData],
        amuletData,
        characterData,
      }
      await GuildWars2Build.findOneAndUpdate(
        { character: usedCharacter, key: apiKey },
        {
          $set: {
            character: usedCharacter,
            key: apiKey,
            data: toStore,
            lastUpdated: new Date(),
          },
        },
        {
          upsert: true,
        }
      )
      if (!abortController.signal.aborted) {
        response.setHeader('Cache-Control', 'max-age=300')
        response.json(toStore || {})
      }
    } else {
      if (!abortController.signal.aborted) {
        response.status(500).json({ error: 'Not okay' })
      }
    }
  } catch (e) {
    const err: Error = e
    if (err.message.includes('The user aborted a request.')) return
    console.error('[error]', e)
    if (!abortController.signal.aborted) {
      response.status(500).json({ error: 'Not okay', message: err.message })
    }
  }
}

async function fallback(originalApiKey: string, character: string, response: NextApiResponse) {
  const apiKey = encodeURIComponent(originalApiKey)
  const match = await GuildWars2Build.findOne({
    character,
    key: apiKey,
  })
  if (match) {
    logger.do('fallback')
    response.setHeader('Cache-Control', 'max-age=300')
    response.json(match.data)
    return
  } else {
    response.status(400).json({})
  }
}

export default handler
