import express from 'express'
import pg from 'pg'
import fs from 'fs'
import puppeteer from 'puppeteer'
import axios from 'axios'
import { JSDOM } from 'jsdom'
import { XMLParser } from 'fast-xml-parser'

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
})
db.connect()
await db.query(`CREATE TABLE IF NOT EXISTS data (
  id bigserial primary key,
  date VARCHAR(24) UNIQUE,
  cb FLOAT,
  ali FLOAT,
  exc FLOAT
)`)

const html = fs.readFileSync('./index.html', 'utf8')
const app = express()
app.get('/', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM data ORDER BY id ASC')
  const ali = []
  const cb = []
  const exc = []
  for (const e of rows) {
    ali.push({
      x: e.date,
      y: e.ali,
    })
    cb.push({
      x: e.date,
      y: e.cb,
    })
    exc.push({
      x: e.date,
      y: e.exc,
    })
  }
  res.send(
    html
      .replace("'aliData'", JSON.stringify(ali))
      .replace("'cbData'", JSON.stringify(cb))
      .replace("'excData'", JSON.stringify(exc))
      .replace(/aliCurrent/g, ali[ali.length - 1]?.y || '?')
      .replace(/cbCurrent/g, cb[cb.length - 1]?.y || '?')
      .replace(/excCurrent/g, exc[exc.length - 1]?.y || '?')
  )
})

let actual
app.get('/update', async (req, res) => {
  if (!actual) {
    actual = true
    try {
      const getAli = async () => {
        let ali
        const browser = await puppeteer.launch({
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
          headless: !process.env.DEV,
        })
        try {
          const page = await browser.newPage()
          await page.goto(process.env.ALIEXPRESS)
          await page.waitForSelector('.product-price-current', { timeout: 5000 })
          const value = await page.$eval('.product-price-current', e => e.textContent)
          ali = (+value.replace(/[^\d,]/g, 5).replace(',', '.')).toFixed(3)
        } catch (e) {
          console.log(e)
          ali = (await db.query('SELECT ali FROM data ORDER BY id DESC LIMIT 1')).rows[0]?.ali || null
        }
        await browser.close()
        return ali
      }
      const getCb = async () => {
        let cb
        try {
          const { data } = await axios.get('https://cbr.ru/scripts/XML_daily.asp')
          const xml = new XMLParser().parse(data)
          cb = (+xml.ValCurs.Valute.find(e => e.CharCode === 'USD')
            .Value.replace(/[^\d,]/g, 5)
            .replace(',', '.')).toFixed(3)
        } catch (e) {
          console.log(e)
          cb = (await db.query('SELECT cb FROM data ORDER BY id DESC LIMIT 1')).rows[0]?.cb || null
        }
        return cb
      }
      const getExc = async () => {
        let exc
        try {
          const { data } = await axios.get('https://ru.investing.com/currencies/usd-rub/')
          const document = new JSDOM(data).window.document
          exc = (+document
            .querySelector('[data-test=instrument-price-last]')
            .innerHTML.replace(/[^\d,]/g, 5)
            .replace(',', '.')).toFixed(3)
        } catch (e) {
          console.log(e)
          exc = (await db.query('SELECT exc FROM data ORDER BY id DESC LIMIT 1')).rows[0]?.exc || null
        }
        return exc
      }
      const [cb, ali, exc] = await Promise.all([getCb(), getAli(), getExc()])
      const last = (await db.query('SELECT * FROM data ORDER BY id DESC LIMIT 1')).rows[0]
      const value = [new Date().toISOString(), cb, ali, exc]
      if (last?.cb != cb || last?.ali != ali || last?.exc != exc)
        await db.query('INSERT INTO data (date, cb, ali, exc) VALUES ($1, $2, $3, $4)', value)
      res.send(value)
    } finally {
      setTimeout(() => (actual = false), 1000 * 60 * process.env.ACTUAL)
    }
    res.end()
  }
})

const port = process.env.PORT || 8084
app.listen(port, () => console.log('Started. Port: ' + port))
