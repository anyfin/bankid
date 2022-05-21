import QRCode from 'qrcode'
import { useState } from 'react'

function App() {
  const [src, setSrc] = useState('')

  const postReq = async (url, body) => {
    try{
      const req = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const { data, err } = await req.json()
      if(err) throw new Error(err)
      return data
    }
    catch(err){
      console.log(err.message)
    }
  }

  const collectQR = async (orderRef, seconds, timer) => {
    const collectAuth = await postReq('http://localhost:8080/collect', {
      orderRef
    })
    seconds = 0
    clearInterval(timer)
    if(collectAuth && collectAuth.user) console.log(collectAuth.user)
    else initiateQR()
  }

  const generateQR = async (orderRef, qrStartToken, qrStartSecret) => {
    let seconds = 0;
    const timer = setInterval(async () => {
      seconds++;
      const generateAuth = await postReq('http://localhost:8080/encrypt', {
        qrStartSecret,
        seconds
      })
      const qrAuthToken = await generateAuth
      const message = 'bankid.' + qrStartToken + '.' + seconds + '.' + qrAuthToken
      const qr = await QRCode.toDataURL(message, {
        errorCorrectionLevel: 'L',
      })
      setSrc(qr)
    }, 1000)
    collectQR(orderRef, seconds, timer)
  }

  const initiateQR = async () => {
    try{
      const initiateAuth = await fetch('http://localhost:8080/')
      const responseAuth = await initiateAuth.json()
      const { orderRef, qrStartToken, qrStartSecret } = await responseAuth.data
      generateQR(orderRef, qrStartToken, qrStartSecret)
    }
    catch(err){
      console.log(err.message)
    }
  }

  return (
    <div style={{width: '100vw', height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column'}}>
      <img src={src} />
      <div>
        <button onClick={initiateQR}>Generate QR</button>
      </div>
    </div>
  );
}

export default App;