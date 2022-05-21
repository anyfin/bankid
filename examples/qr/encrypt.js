const crypto = require('crypto')

export default async function encrypt(req, res){
  try{
    const { qrStartSecret, seconds } = req.body
    res.status(200).json({
      data: crypto.createHmac('SHA256', qrStartSecret).update(seconds.toString()).digest('hex')
    })
  }
  catch(err){
    res.status(500).json({ err: err.message })
  }
}