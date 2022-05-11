import QRCode from 'qrcode'
import { useState } from 'react'

function App() {
  const [src, setSrc] = useState('')

  const collectQR = async (orderRef) => {
    const collect = await fetch('http://localhost:8080/collect', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderRef
      }),
    })
    const user = await collect.json()
    console.log(user)
  }

  const generateQR = async (orderRef, qrStartToken, qrStartSecret) => {
    let seconds = 0;
    const timer = setInterval(async () => {
      if(seconds === 20){
        clearInterval(timer)
        initiateQR()
      }
      else{
        seconds++;
        let qrAuthCode = await fetch('http://localhost:8080/encrypt', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            qrStartSecret,
            seconds
          }),
        })
        let response = await qrAuthCode.json()
        let { data } = await response
        const message = 'bankid.' + qrStartToken + '.' + seconds + '.' + data
        const qr = await QRCode.toDataURL(message, {
          errorCorrectionLevel: 'L',
        })
        setSrc(qr)
      }
    }, 1000)
    collectQR(orderRef)
  }

  const initiateQR = async () => {
    const initiateAuth = await fetch('http://localhost:8080/')
    const responseAuth = await initiateAuth.json()
    const { orderRef, qrStartToken, qrStartSecret } = await responseAuth.data
    generateQR(orderRef, qrStartToken, qrStartSecret)
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
