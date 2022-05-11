const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const bodyParser = require('body-parser')

const bankIdRoute = require('./routes/bankid')

const app = express()

app.use(cors())
app.use(morgan('dev'))
app.use(bodyParser.json())

app.use('/', bankIdRoute)

app.use((req, res, next) => {
  throw {status: 404, message: 'Not found'};
})

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({err})
})

app.listen(8080)