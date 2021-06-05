import { Document, Schema, Model } from 'mongoose'
import { connect } from '../mongo'

const connection = connect()

export interface GuildWars2Build {
  key: string
  character: string
  data: any
  lastUpdated: Date
}

interface ItemDocument extends GuildWars2Build, Document {}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ItemModel extends Model<ItemDocument> {}

const itemSchema = new Schema<ItemDocument, ItemModel>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    character: {
      type: String,
      required: true,
      trim: true,
    },
    lastUpdated: {
      type: Date,
      required: true,
    },
    data: {
      type: Schema.Types.Mixed,
    },
  },
  {
    id: false,
  }
)

const Item = connection.model<ItemDocument, ItemModel>('GuildWars2Build', itemSchema)

export default Item
