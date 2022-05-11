const fs = require('fs')
const path = require('path')
const express = require('express')
const router = express.Router()

const BankId = require('bankid')
const requestIp = require('request-ip')
const crypto = require('crypto')

router.get('/', async (req, res, next) => {
  try{
    const client = new BankId.BankIdClient(
      // {
      //   production: true,
      //   pfx: fs.readFileSync(dir),
      //   passphrase: process.env.PASSPHRASE
      // }
    )
    const authenticate = await client.authenticate({
      endUserIp: requestIp.getClientIp(req)
    })
    res.status(200).json({ data: authenticate })
  }
  catch(err){
    next(err)
  }
})

router.post('/encrypt', async (req, res, next) => {
  try{
    const { qrStartSecret, seconds } = req.body
    res.status(200).json({
      data: crypto.createHmac('SHA256', qrStartSecret).update(seconds.toString()).digest('hex')
    })
  }
  catch(err){
    next(err)
  }
})

router.post('/collect', async(req, res, next) => {
  try{
    const { orderRef } = req.body
    const client = new BankId.BankIdClient(
      // {
      //   production: true,
      //   pfx: fs.readFileSync(dir),
      //   passphrase: process.env.PASSPHRASE
		  // }
    );
    const timer = setInterval(async () => {
      const done = () => clearInterval(timer);
      try{
        const collect = await client.collect({
          orderRef
        })
        if(collect.status === 'complete'){
          done()
          res.status(200).json({data: collect.completionData})
        }
        else if(collect.status === 'failed'){
          done()
          res.status(200).json({data: {}})
        }
      }
      catch(error){
        done()
        res.status(500).json({error})
      }
    }, 1000);
  }
  catch(err){
    next(err)
  }
})

module.exports = router