import { NextApiHandler } from 'next'
import fetch from 'isomorphic-fetch'
import subMinutes from 'date-fns/subMinutes'
import GuildWars2Build from '../../../../db/models/GuildWars2Build'
import { runMiddleware, cors } from '../../../../middleware'

const logger = {
  start: (tag, ...args) => console.info(`[start:${tag}]`, ...args),
  end: (tag, ...args) => console.info(`[end:${tag}]`, ...args),
  do: (tag, ...args) => console.info(`[${tag}]`, ...args),
  warn: (msg) => console.warn('[warn]', msg),
}

const handler: NextApiHandler = async (req, response) => {
  await runMiddleware(req, response, cors)
  try {
    let apiKey = req.query.key.toString()
    const character = req.query.character.toString()
    if (!apiKey) return
    apiKey = encodeURIComponent(apiKey)
    const match = await GuildWars2Build.findOne({
      character,
      key: apiKey,
      lastUpdated: { $gte: subMinutes(new Date(), 5) },
    })
    if (match) {
      response.setHeader('Cache-Control', 'max-age=300')
      response.json(match.data)
      return
    }
    logger.start('character')
    const res = await fetch(`https://api.guildwars2.com/v2/characters?access_token=${apiKey}&ids=all`)
    if (res.ok) {
      const data = await res.json()
      logger.end('character')
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

      logger.do('skins')
      const skins = characterData.equipment.map((item) => item?.skin).filter(Boolean)
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
          characterData.equipment
            .flatMap((item) => [item?.id, item?.upgrades, item?.infusions].filter(Boolean))
            .filter(Boolean)
        )

      console.info('[start:extra]', { equipment: equipmentIds, skins, skills, traits, specializations })

      const [equipmentData, skinData, skillData, traitData, specializationData, amuletData] = await Promise.all([
        fetch(`https://api.guildwars2.com/v2/items?access_token=${apiKey}&ids=${equipmentIds}`)
          .then((r) => r.json())
          .then((d) => new Map(d.map((i) => [i.id, i]))),
        skins.length === 0
          ? new Map()
          : fetch(`https://api.guildwars2.com/v2/skins?access_token=${apiKey}&ids=${skins}`)
              .then((r) => r.json())
              .then((d) => new Map(d.map((i) => [i.id, i]))),
        skills.length === 0
          ? new Map()
          : fetch(`https://api.guildwars2.com/v2/skills?access_token=${apiKey}&ids=${skills}`)
              .then((r) => r.json())
              .then((d) => new Map(d.map((i) => [i.id, i]))),
        traits.length === 0
          ? new Map()
          : fetch(`https://api.guildwars2.com/v2/traits?access_token=${apiKey}&ids=${traits}`)
              .then((r) => r.json())
              .then((d) => new Map(d.map((i) => [i.id, i]))),
        specializations.length === 0
          ? new Map()
          : fetch(`https://api.guildwars2.com/v2/specializations?access_token=${apiKey}&ids=${specializations}`)
              .then((r) => r.json())
              .then((d) => new Map(d.map((i) => [i.id, i]))),
        !characterData?.equipment_pvp?.amulet
          ? undefined
          : fetch(
              `https://api.guildwars2.com/v2/pvp/amulets?access_token=${apiKey}&id=${characterData.equipment_pvp.amulet}`
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
      response.setHeader('Cache-Control', 'max-age=300')
      response.json(toStore || {})
    } else {
      response.status(500).json({ error: 'Not okay' })
    }
  } catch (e) {
    console.error('[error]', e)
    response.status(500).json({ error: 'Not okay', message: e.message })
  }
}

export default handler
