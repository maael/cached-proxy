import mongoose from 'mongoose'

let connection: mongoose.Connection

export function connect() {
  if (connection) return connection
  console.info('[new connection]')
  connection = mongoose.createConnection(process.env.MONGO_DB_URI!, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
    useCreateIndex: true,
  })

  return connection
}
