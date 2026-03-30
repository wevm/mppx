import * as Html from './constants.js'

const toDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

const cloudflareLightSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101.4 33.5">
  <title>Cloudflare logo</title>
  <path fill="#fff" d="M94.7,10.6,89.1,9.3l-1-.4-25.7.2V21.5l32.3.1Z"/>
  <path fill="#f48120" d="M84.2,20.4a2.85546,2.85546,0,0,0-.3-2.6,3.09428,3.09428,0,0,0-2.1-1.1l-17.4-.2c-.1,0-.2-.1-.3-.1a.1875.1875,0,0,1,0-.3c.1-.2.2-.3.4-.3L82,15.6a6.29223,6.29223,0,0,0,5.1-3.8l1-2.6c0-.1.1-.2,0-.3A11.39646,11.39646,0,0,0,66.2,7.7a5.45941,5.45941,0,0,0-3.6-1A5.20936,5.20936,0,0,0,58,11.3a5.46262,5.46262,0,0,0,.1,1.8A7.30177,7.30177,0,0,0,51,20.4a4.102,4.102,0,0,0,.1,1.1.3193.3193,0,0,0,.3.3H83.5c.2,0,.4-.1.4-.3Z"/>
  <path fill="#faad3f" d="M89.7,9.2h-.5c-.1,0-.2.1-.3.2l-.7,2.4a2.85546,2.85546,0,0,0,.3,2.6,3.09428,3.09428,0,0,0,2.1,1.1l3.7.2c.1,0,.2.1.3.1a.1875.1875,0,0,1,0,.3c-.1.2-.2.3-.4.3l-3.8.2a6.29223,6.29223,0,0,0-5.1,3.8l-.2.9c-.1.1,0,.3.2.3H98.5a.26517.26517,0,0,0,.3-.3,10.87184,10.87184,0,0,0,.4-2.6,9.56045,9.56045,0,0,0-9.5-9.5"/>
  <path fill="#404041" d="M100.5,27.2a.9.9,0,1,1,.9-.9.89626.89626,0,0,1-.9.9m0-1.6a.7.7,0,1,0,.7.7.68354.68354,0,0,0-.7-.7m.4,1.2h-.2l-.2-.3h-.2v.3h-.2v-.9h.5a.26517.26517,0,0,1,.3.3c0,.1-.1.2-.2.3l.2.3Zm-.3-.5c.1,0,.1,0,.1-.1a.09794.09794,0,0,0-.1-.1h-.3v.3h.3Zm-89.7-.9h2.2v6h3.8v1.9h-6Zm8.3,3.9a4.10491,4.10491,0,0,1,4.3-4.1,4.02,4.02,0,0,1,4.2,4.1,4.10491,4.10491,0,0,1-4.3,4.1,4.07888,4.07888,0,0,1-4.2-4.1m6.3,0a2.05565,2.05565,0,0,0-2-2.2,2.1025,2.1025,0,0,0,0,4.2c1.2.2,2-.8,2-2m4.9.5V25.4h2.2v4.4c0,1.1.6,1.7,1.5,1.7a1.39926,1.39926,0,0,0,1.5-1.6V25.4h2.2v4.4c0,2.6-1.5,3.7-3.7,3.7-2.3-.1-3.7-1.2-3.7-3.7m10.7-4.4h3.1c2.8,0,4.5,1.6,4.5,3.9s-1.7,4-4.5,4h-3V25.4Zm3.1,5.9a2.00909,2.00909,0,1,0,0-4h-.9v4Zm7.6-5.9h6.3v1.9H54v1.3h3.7v1.8H54v2.9H51.8Zm9.4,0h2.2v6h3.8v1.9h-6Zm11.7-.1h2.2l3.4,8H76.1l-.6-1.4H72.4l-.6,1.4H69.5Zm2,4.9L74,28l-.9,2.2Zm6.4-4.8H85a3.41818,3.41818,0,0,1,2.6.9,2.62373,2.62373,0,0,1-.9,4.2l1.9,2.8H86.1l-1.6-2.4h-1v2.4H81.3Zm3.6,3.8c.7,0,1.2-.4,1.2-.9,0-.6-.5-.9-1.2-.9H83.5v1.9h1.4Zm6.5-3.8h6.4v1.8H93.6v1.2h3.8v1.8H93.6v1.2h4.3v1.9H91.4ZM6.1,30.3a1.97548,1.97548,0,0,1-1.8,1.2,2.1025,2.1025,0,0,1,0-4.2,2.0977,2.0977,0,0,1,1.9,1.3H8.5a4.13459,4.13459,0,0,0-4.2-3.3A4.1651,4.1651,0,0,0,0,29.4a4.07888,4.07888,0,0,0,4.2,4.1,4.31812,4.31812,0,0,0,4.2-3.2Z"/>
</svg>`

const nytLightSvg = `<svg width="185" height="25" xmlns="http://www.w3.org/2000/svg"><path d="M13.8 2.9c0-2-1.9-2.5-3.4-2.5v.3c.9 0 1.6.3 1.6 1 0 .4-.3 1-1.2 1-.7 0-2.2-.4-3.3-.8C6.2 1.4 5 1 4 1 2 1 .6 2.5.6 4.2c0 1.5 1.1 2 1.5 2.2l.1-.2c-.2-.2-.5-.4-.5-1 0-.4.4-1.1 1.4-1.1.9 0 2.1.4 3.7.9 1.4.4 2.9.7 3.7.8v3.1L9 10.2v.1l1.5 1.3v4.3c-.8.5-1.7.6-2.5.6-1.5 0-2.8-.4-3.9-1.6l4.1-2V6l-5 2.2C3.6 6.9 4.7 6 5.8 5.4l-.1-.3c-3 .8-5.7 3.6-5.7 7 0 4 3.3 7 7 7 4 0 6.6-3.2 6.6-6.5h-.2c-.6 1.3-1.5 2.5-2.6 3.1v-4.1l1.6-1.3v-.1l-1.6-1.3V5.8c1.5 0 3-1 3-2.9zm-8.7 11l-1.2.6c-.7-.9-1.1-2.1-1.1-3.8 0-.7 0-1.5.2-2.1l2.1-.9v6.2zm10.6 2.3l-1.3 1 .2.2.6-.5 2.2 2 3-2-.1-.2-.8.5-1-1V9.4l.8-.6 1.7 1.4v6.1c0 3.8-.8 4.4-2.5 5v.3c2.8.1 5.4-.8 5.4-5.7V9.3l.9-.7-.2-.2-.8.6-2.5-2.1L18.5 9V.8h-.2l-3.5 2.4v.2c.4.2 1 .4 1 1.5l-.1 11.3zM34 15.1L31.5 17 29 15v-1.2l4.7-3.2v-.1l-2.4-3.6-5.2 2.8v6.6l-1 .8.2.2.9-.7 3.4 2.5 4.5-3.6-.1-.4zm-5-1.7V8.5l.2-.1 2.2 3.5-2.4 1.5zM53.1 2c0-.3-.1-.6-.2-.9h-.2c-.3.8-.7 1.2-1.7 1.2-.9 0-1.5-.5-1.9-.9l-2.9 3.3.2.2 1-.9c.6.5 1.1.9 2.5 1v8.3L44 3.2c-.5-.8-1.2-1.9-2.6-1.9-1.6 0-3 1.4-2.8 3.6h.3c.1-.6.4-1.3 1.1-1.3.5 0 1 .5 1.3 1v3.3c-1.8 0-3 .8-3 2.3 0 .8.4 2 1.6 2.3v-.2c-.2-.2-.3-.4-.3-.7 0-.5.4-.9 1.1-.9h.5v4.2c-2.1 0-3.8 1.2-3.8 3.2 0 1.9 1.6 2.8 3.4 2.7v-.2c-1.1-.1-1.6-.6-1.6-1.3 0-.9.6-1.3 1.4-1.3.8 0 1.5.5 2 1.1l2.9-3.2-.2-.2-.7.8c-1.1-1-1.7-1.3-3-1.5V5l8 14h.6V5c1.5-.1 2.9-1.3 2.9-3zm7.3 13.1L57.9 17l-2.5-2v-1.2l4.7-3.2v-.1l-2.4-3.6-5.2 2.8v6.6l-1 .8.2.2.9-.7 3.4 2.5 4.5-3.6-.1-.4zm-5-1.7V8.5l.2-.1 2.2 3.5-2.4 1.5zM76.7 8l-.7.5-1.9-1.6-2.2 2 .9.9v7.5l-2.4-1.5V9.6l.8-.5-2.3-2.2-2.2 2 .9.9V17l-.3.2-2.1-1.5v-6c0-1.4-.7-1.8-1.5-2.3-.7-.5-1.1-.8-1.1-1.5 0-.6.6-.9.9-1.1v-.2c-.8 0-2.9.8-2.9 2.7 0 1 .5 1.4 1 1.9s1 .9 1 1.8v5.8l-1.1.8.2.2 1-.8 2.3 2 2.5-1.7 2.8 1.7 5.3-3.1V9.2l1.3-1-.2-.2zm18.6-5.5l-1 .9-2.2-2-3.3 2.4V1.6h-.3l.1 16.2c-.3 0-1.2-.2-1.9-.4l-.2-13.5c0-1-.7-2.4-2.5-2.4s-3 1.4-3 2.8h.3c.1-.6.4-1.1 1-1.1s1.1.4 1.1 1.7v3.9c-1.8.1-2.9 1.1-2.9 2.4 0 .8.4 2 1.6 2V13c-.4-.2-.5-.5-.5-.7 0-.6.5-.8 1.3-.8h.4v6.2c-1.5.5-2.1 1.6-2.1 2.8 0 1.7 1.3 2.9 3.3 2.9 1.4 0 2.6-.2 3.8-.5 1-.2 2.3-.5 2.9-.5.8 0 1.1.4 1.1.9 0 .7-.3 1-.7 1.1v.2c1.6-.3 2.6-1.3 2.6-2.8 0-1.5-1.5-2.4-3.1-2.4-.8 0-2.5.3-3.7.5-1.4.3-2.8.5-3.2.5-.7 0-1.5-.3-1.5-1.3 0-.8.7-1.5 2.4-1.5.9 0 2 .1 3.1.4 1.2.3 2.3.6 3.3.6 1.5 0 2.8-.5 2.8-2.6V3.7l1.2-1-.2-.2zm-4.1 6.1c-.3.3-.7.6-1.2.6s-1-.3-1.2-.6V4.2l1-.7 1.4 1.3v3.8zm0 3c-.2-.2-.7-.5-1.2-.5s-1 .3-1.2.5V9c.2.2.7.5 1.2.5s1-.3 1.2-.5v2.6zm0 4.7c0 .8-.5 1.6-1.6 1.6h-.8V12c.2-.2.7-.5 1.2-.5s.9.3 1.2.5v4.3zm13.7-7.1l-3.2-2.3-4.9 2.8v6.5l-1 .8.1.2.8-.6 3.2 2.4 5-3V9.2zm-5.4 6.3V8.3l2.5 1.8v7.1l-2.5-1.7zm14.9-8.4h-.2c-.3.2-.6.4-.9.4-.4 0-.9-.2-1.1-.5h-.2l-1.7 1.9-1.7-1.9-3 2 .1.2.8-.5 1 1.1v6.3l-1.3 1 .2.2.6-.5 2.4 2 3.1-2.1-.1-.2-.9.5-1.2-1V9c.5.5 1.1 1 1.8 1 1.4.1 2.2-1.3 2.3-2.9zm12 9.6L123 19l-4.6-7 3.3-5.1h.2c.4.4 1 .8 1.7.8s1.2-.4 1.5-.8h.2c-.1 2-1.5 3.2-2.5 3.2s-1.5-.5-2.1-.8l-.3.5 5 7.4 1-.6v.1zm-11-.5l-1.3 1 .2.2.6-.5 2.2 2 3-2-.2-.2-.8.5-1-1V.8h-.1l-3.6 2.4v.2c.4.2 1 .3 1 1.5v11.3zM143 2.9c0-2-1.9-2.5-3.4-2.5v.3c.9 0 1.6.3 1.6 1 0 .4-.3 1-1.2 1-.7 0-2.2-.4-3.3-.8-1.3-.4-2.5-.8-3.5-.8-2 0-3.4 1.5-3.4 3.2 0 1.5 1.1 2 1.5 2.2l.1-.2c-.3-.2-.6-.4-.6-1 0-.4.4-1.1 1.4-1.1.9 0 2.1.4 3.7.9 1.4.4 2.9.7 3.7.8V9l-1.5 1.3v.1l1.5 1.3V16c-.8.5-1.7.6-2.5.6-1.5 0-2.8-.4-3.9-1.6l4.1-2V6l-5 2.2c.5-1.3 1.6-2.2 2.6-2.9l-.1-.2c-3 .8-5.7 3.5-5.7 6.9 0 4 3.3 7 7 7 4 0 6.6-3.2 6.6-6.5h-.2c-.6 1.3-1.5 2.5-2.6 3.1v-4.1l1.6-1.3v-.1L140 8.8v-3c1.5 0 3-1 3-2.9zm-8.7 11l-1.2.6c-.7-.9-1.1-2.1-1.1-3.8 0-.7.1-1.5.3-2.1l2.1-.9-.1 6.2zm12.2-12h-.1l-2 1.7v.1l1.7 1.9h.2l2-1.7v-.1l-1.8-1.9zm3 14.8l-.8.5-1-1V9.3l1-.7-.2-.2-.7.6-1.8-2.1-2.9 2 .2.3.7-.5.9 1.1v6.5l-1.3 1 .1.2.7-.5 2.2 2 3-2-.1-.3zm16.7-.1l-.7.5-1.1-1V9.3l1-.8-.2-.2-.8.7-2.3-2.1-3 2.1-2.3-2.1L154 9l-1.8-2.1-2.9 2 .1.3.7-.5 1 1.1v6.5l-.8.8 2.3 1.9 2.2-2-.9-.9V9.3l.9-.6 1.5 1.4v6l-.8.8 2.3 1.9 2.2-2-.9-.9V9.3l.8-.5 1.6 1.4v6l-.7.7 2.3 2.1 3.1-2.1v-.3zm8.7-1.5l-2.5 1.9-2.5-2v-1.2l4.7-3.2v-.1l-2.4-3.6-5.2 2.8v6.8l3.5 2.5 4.5-3.6-.1-.3zm-5-1.7V8.5l.2-.1 2.2 3.5-2.4 1.5zm14.1-.9l-1.9-1.5c1.3-1.1 1.8-2.6 1.8-3.6v-.6h-.2c-.2.5-.6 1-1.4 1-.8 0-1.3-.4-1.8-1L176 9.3v3.6l1.7 1.3c-1.7 1.5-2 2.5-2 3.3 0 1 .5 1.7 1.3 2l.1-.2c-.2-.2-.4-.3-.4-.8 0-.3.4-.8 1.2-.8 1 0 1.6.7 1.9 1l4.3-2.6v-3.6h-.1zm-1.1-3c-.7 1.2-2.2 2.4-3.1 3l-1.1-.9V8.1c.4 1 1.5 1.8 2.6 1.8.7 0 1.1-.1 1.6-.4zm-1.7 8c-.5-1.1-1.7-1.9-2.9-1.9-.3 0-1.1 0-1.9.5.5-.8 1.8-2.2 3.5-3.2l1.2 1 .1 3.6z"/></svg>`

const stripeLightSvg = `<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" style="enable-background:new 0 0 468 222.5;" xml:space="preserve" viewBox="54 36 360.02 149.84"> <g> 	<path fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" d="M414,113.4c0-25.6-12.4-45.8-36.1-45.8c-23.8,0-38.2,20.2-38.2,45.6c0,30.1,17,45.3,41.4,45.3 		c11.9,0,20.9-2.7,27.7-6.5v-20c-6.8,3.4-14.6,5.5-24.5,5.5c-9.7,0-18.3-3.4-19.4-15.2h48.9C413.8,121,414,115.8,414,113.4z 		 M364.6,103.9c0-11.3,6.9-16,13.2-16c6.1,0,12.6,4.7,12.6,16H364.6z"></path> 	<path fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" d="M301.1,67.6c-9.8,0-16.1,4.6-19.6,7.8l-1.3-6.2h-22v116.6l25-5.3l0.1-28.3c3.6,2.6,8.9,6.3,17.7,6.3 		c17.9,0,34.2-14.4,34.2-46.1C335.1,83.4,318.6,67.6,301.1,67.6z M295.1,136.5c-5.9,0-9.4-2.1-11.8-4.7l-0.1-37.1 		c2.6-2.9,6.2-4.9,11.9-4.9c9.1,0,15.4,10.2,15.4,23.3C310.5,126.5,304.3,136.5,295.1,136.5z"></path> 	<polygon fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" points="223.8,61.7 248.9,56.3 248.9,36 223.8,41.3 	"></polygon> 	<rect x="223.8" y="69.3" fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" width="25.1" height="87.5"></rect> 	<path fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" d="M196.9,76.7l-1.6-7.4h-21.6v87.5h25V97.5c5.9-7.7,15.9-6.3,19-5.2v-23C214.5,68.1,202.8,65.9,196.9,76.7z"></path> 	<path fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" d="M146.9,47.6l-24.4,5.2l-0.1,80.1c0,14.8,11.1,25.7,25.9,25.7c8.2,0,14.2-1.5,17.5-3.3V135 		c-3.2,1.3-19,5.9-19-8.9V90.6h19V69.3h-19L146.9,47.6z"></path> 	<path fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd" d="M79.3,94.7c0-3.9,3.2-5.4,8.5-5.4c7.6,0,17.2,2.3,24.8,6.4V72.2c-8.3-3.3-16.5-4.6-24.8-4.6 		C67.5,67.6,54,78.2,54,95.9c0,27.6,38,23.2,38,35.1c0,4.6-4,6.1-9.6,6.1c-8.3,0-18.9-3.4-27.3-8v23.8c9.3,4,18.7,5.7,27.3,5.7 		c20.8,0,35.1-10.3,35.1-28.2C117.4,100.6,79.3,105.9,79.3,94.7z"></path> </g> </svg>`

const vercelDarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="#ffffff" viewBox="0 0 284 65"><path d="M141.68 16.25c-11.04 0-19 7.2-19 18s8.96 18 20 18c6.67 0 12.55-2.64 16.19-7.09l-7.65-4.42c-2.02 2.21-5.09 3.5-8.54 3.5-4.79 0-8.86-2.5-10.37-6.5h28.02c.22-1.12.35-2.28.35-3.5 0-10.79-7.96-17.99-19-17.99zm-9.46 14.5c1.25-3.99 4.67-6.5 9.45-6.5 4.79 0 8.21 2.51 9.45 6.5h-18.9zm117.14-14.5c-11.04 0-19 7.2-19 18s8.96 18 20 18c6.67 0 12.55-2.64 16.19-7.09l-7.65-4.42c-2.02 2.21-5.09 3.5-8.54 3.5-4.79 0-8.86-2.5-10.37-6.5h28.02c.22-1.12.35-2.28.35-3.5 0-10.79-7.96-17.99-19-17.99zm-9.45 14.5c1.25-3.99 4.67-6.5 9.45-6.5 4.79 0 8.21 2.51 9.45 6.5h-18.9zm-39.03 3.5c0 6 3.92 10 10 10 4.12 0 7.21-1.87 8.8-4.92l7.68 4.43c-3.18 5.3-9.14 8.49-16.48 8.49-11.05 0-19-7.2-19-18s7.96-18 19-18c7.34 0 13.29 3.19 16.48 8.49l-7.68 4.43c-1.59-3.05-4.68-4.92-8.8-4.92-6.07 0-10 4-10 10zm82.48-29v46h-9v-46h9zM37.59.25l36.95 64H.64l36.95-64zm92.38 5l-27.71 48-27.71-48h10.39l17.32 30 17.32-30h10.39zm58.91 12v9.69c-1-.29-2.06-.49-3.2-.49-5.81 0-10 4-10 10v14.8h-9v-34h9v9.2c0-5.08 5.91-9.2 13.2-9.2z" /></svg>`

const tempoSvg = (fill: string) =>
  `<svg width="184" height="41" viewBox="0 0 184 41" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.6424 40.3635H2.80251L12.8492 9.60026H0L2.80251 0.58344H38.6006L35.7981 9.60026H23.6362L13.6424 40.3635Z" fill="${fill}"/><path d="M53.9809 40.3635H28.2824L41.1846 0.58344H66.7773L64.3449 8.16818H49.4863L46.7896 16.7076H61.1723L58.7399 24.1863H44.3043L41.6076 32.7788H56.3604L53.9809 40.3635Z" fill="${fill}"/><path d="M65.6123 40.3635H56.9933L69.9483 0.58344H84.331L83.8551 22.0647L97.8676 0.58344H113.625L100.723 40.3635H89.936L98.5021 13.6313H98.3435L80.7353 40.3635H74.3371L74.6015 13.3131H74.4957L65.6123 40.3635Z" fill="${fill}"/><path d="M125.758 7.95602L121.581 20.7917H122.744C125.388 20.7917 127.592 20.1729 129.354 18.9353C131.117 17.6624 132.262 15.859 132.791 13.5252C133.249 11.5097 133.003 10.0776 132.051 9.22898C131.099 8.38034 129.513 7.95602 127.292 7.95602H125.758ZM115.289 40.3635H104.449L117.351 0.58344H130.517C133.549 0.58344 136.158 1.07848 138.343 2.06856C140.564 3.02328 142.186 4.40233 143.208 6.20569C144.266 7.97369 144.618 10.0423 144.266 12.4114C143.807 15.5231 142.609 18.2635 140.67 20.6326C138.731 23.0017 136.211 24.8405 133.108 26.1488C130.042 27.4217 126.604 28.0582 122.797 28.0582H119.255L115.289 40.3635Z" fill="${fill}"/><path d="M170.103 37.8176C166.507 39.9392 162.682 41 158.628 41H158.523C154.927 41 151.895 40.2044 149.428 38.6132C146.995 36.9866 145.25 34.7943 144.193 32.0362C143.171 29.2781 142.924 26.2549 143.453 22.9664C144.122 18.8292 145.656 15.0103 148.053 11.5097C150.45 8.00906 153.446 5.21561 157.042 3.12937C160.638 1.04312 164.48 0 168.569 0H168.675C172.412 0 175.496 0.795602 177.929 2.38681C180.396 3.97801 182.106 6.15265 183.058 8.91074C184.045 11.6335 184.256 14.6921 183.692 18.0867C183.023 22.0824 181.489 25.8482 179.092 29.3842C176.695 32.8849 173.699 35.696 170.103 37.8176ZM155.138 30.9754C156.09 32.7788 157.747 33.6805 160.109 33.6805H160.215C162.154 33.6805 163.951 32.9556 165.608 31.5058C167.3 30.0207 168.728 28.0405 169.891 25.5653C171.09 23.0901 171.971 20.332 172.535 17.2911C173.064 14.3208 172.852 11.934 171.901 10.1307C170.949 8.29194 169.31 7.37257 166.983 7.37257H166.877C165.079 7.37257 163.335 8.11514 161.642 9.60026C159.986 11.0854 158.54 13.0832 157.306 15.5938C156.073 18.1044 155.174 20.8271 154.61 23.762C154.046 26.7322 154.222 29.1367 155.138 30.9754Z" fill="${fill}"/></svg>`

const tempoLightLogo = toDataUrl(tempoSvg('#0a0a0a'))
const tempoDarkLogo = toDataUrl(tempoSvg('#ffffff'))

const cloudflareLogo = toDataUrl(cloudflareLightSvg)

const stripeLogo = toDataUrl(stripeLightSvg)

const nytLogo = toDataUrl(nytLightSvg)

const vercelLogo = toDataUrl(vercelDarkSvg)

type ThemeColors = {
  '--mppx-accent': string
  '--mppx-background': string
  '--mppx-foreground': string
  '--mppx-muted': string
  '--mppx-surface': string
  '--mppx-border': string
  [key: string]: string
}

type SystemThemeEntry = {
  mode: 'system'
  light: ThemeColors
  dark: ThemeColors
  logo?: { light: string; dark: string }
}

type FixedThemeEntry = {
  mode: 'light' | 'dark'
  colors: ThemeColors
  logo?: string
}

type ThemeEntry = SystemThemeEntry | FixedThemeEntry

const systemTheme = {
  light: {
    '--mppx-accent': '#171717',
    '--mppx-background': '#ffffff',
    '--mppx-foreground': '#0a0a0a',
    '--mppx-muted': '#666666',
    '--mppx-surface': '#f5f5f5',
    '--mppx-border': '#e5e5e5',
  },
  dark: {
    '--mppx-accent': '#ededed',
    '--mppx-background': '#0a0a0a',
    '--mppx-foreground': '#ededed',
    '--mppx-muted': '#a1a1a1',
    '--mppx-surface': '#1a1a1a',
    '--mppx-border': '#2e2e2e',
  },
} satisfies Pick<SystemThemeEntry, 'light' | 'dark'>

const themes: Record<string, ThemeEntry> = {
  System: {
    ...systemTheme,
    mode: 'system',
    logo: { light: tempoLightLogo, dark: tempoDarkLogo },
  },
  Light: {
    colors: systemTheme.light,
    mode: 'light',
    logo: tempoLightLogo,
  },
  Dark: {
    colors: systemTheme.dark,
    mode: 'dark',
    logo: tempoDarkLogo,
  },
  Cloudflare: {
    colors: {
      '--mppx-accent': '#f6821f',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#1a1a1a',
      '--mppx-muted': '#6b7280',
      '--mppx-surface': '#f4f5f7',
      '--mppx-border': '#e5e7eb',
      '--mppx-radius': '8px',
    },
    logo: cloudflareLogo,
    mode: 'light',
  },
  Stripe: {
    colors: {
      '--mppx-accent': '#635bff',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#0a2540',
      '--mppx-muted': '#6b7c93',
      '--mppx-surface': '#f6f9fc',
      '--mppx-border': '#e3e8ee',
      '--mppx-radius': '8px',
    },
    logo: stripeLogo,
    mode: 'light',
  },
  NYT: {
    colors: {
      '--mppx-accent': '#000000',
      '--mppx-background': '#f7f7f5',
      '--mppx-foreground': '#121212',
      '--mppx-muted': '#666666',
      '--mppx-surface': '#eeeee9',
      '--mppx-border': '#dfdfda',
      '--mppx-radius': '2px',
      '--mppx-font-family': 'Georgia, "Times New Roman", Times, serif',
    },
    logo: nytLogo,
    mode: 'light',
  },
  Vercel: {
    colors: {
      '--mppx-accent': '#ffffff',
      '--mppx-background': '#000000',
      '--mppx-foreground': '#ededed',
      '--mppx-muted': '#888888',
      '--mppx-surface': '#111111',
      '--mppx-border': '#333333',
      '--mppx-radius': '6px',
      '--mppx-font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    logo: vercelLogo,
    mode: 'dark',
  },
}

const allKeys = [
  ...new Set(
    Object.values(themes).flatMap((theme) =>
      theme.mode === 'system'
        ? [...Object.keys(theme.light), ...Object.keys(theme.dark)]
        : Object.keys(theme.colors),
    ),
  ),
]

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
const prefersSystemDark = () => mediaQuery.matches

type DebugState = 'default' | 'verifying' | 'success' | 'failed'
const debugStates: DebugState[] = ['default', 'verifying', 'success', 'failed']

function readParams() {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('debug_theme')
  const state = params.get('debug_state') as DebugState | null
  const logo = params.get('debug_logo')
  return {
    theme: theme && theme in themes ? theme : 'System',
    state: state && debugStates.includes(state) ? state : 'default',
    logo: logo === null ? true : logo !== '0',
  }
}

function writeParams() {
  const params = new URLSearchParams(window.location.search)
  if (active === 'System') params.delete('debug_theme')
  else params.set('debug_theme', active)
  if (activeState === 'default') params.delete('debug_state')
  else params.set('debug_state', activeState)
  if (showLogo) params.delete('debug_logo')
  else params.set('debug_logo', '0')
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}

const initial = readParams()
let active = initial.theme
let activeState = initial.state
let showLogo = initial.logo

function prefersDark() {
  const mode = themes[active]?.mode ?? 'system'
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return prefersSystemDark()
}

const widget = document.createElement('div')
widget.id = 'mppx-debug-toolbar'
widget.setAttribute('aria-label', 'MPPX debug toolbar')
Object.assign(widget.style, {
  position: 'fixed',
  top: '12px',
  right: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  zIndex: '9999',
  minWidth: '220px',
  padding: '12px',
  borderRadius: '12px',
  backdropFilter: 'blur(16px)',
  boxShadow: '0 18px 48px rgba(0, 0, 0, 0.22)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '12px',
})

function applyButtonStyles(button: HTMLButtonElement, parameters: { active?: boolean } = {}) {
  const isActive = parameters.active ?? false
  Object.assign(button.style, {
    padding: '7px 10px',
    borderRadius: '8px',
    border: prefersDark() ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.08)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    background: isActive
      ? prefersDark()
        ? 'rgba(255,255,255,0.14)'
        : 'rgba(0,0,0,0.08)'
      : prefersDark()
        ? 'rgba(255,255,255,0.04)'
        : 'rgba(255,255,255,0.7)',
    color: prefersDark() ? '#f5f5f5' : '#171717',
  })
}

function setDebugState(state: DebugState) {
  activeState = state
  writeParams()
  window.dispatchEvent(new CustomEvent('mppx:debug-state', { detail: { state } }))
  render()
}

function applyTheme() {
  const entry = themes[active]!
  const vars = entry.mode === 'system' ? (prefersDark() ? entry.dark : entry.light) : entry.colors
  const root = document.documentElement

  for (const key of allKeys) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)

  const header = document.querySelector(`.${Html.classNames.header}`)
  if (!header) return

  header.querySelectorAll(`.${Html.classNames.logo.split(' ')[0]!}`).forEach((el) => el.remove())
  if (!showLogo || !entry.logo) return

  const logoSrc =
    typeof entry.logo === 'string' ? entry.logo : prefersDark() ? entry.logo.dark : entry.logo.light

  const img = document.createElement('img')
  img.src = logoSrc
  img.alt = ''
  img.className = Html.classNames.logo
  img.style.display = 'block'
  img.style.filter = 'none'
  img.style.height = '30px'
  header.insertBefore(img, header.firstChild)
}

function render() {
  widget.innerHTML = ''

  Object.assign(widget.style, {
    background: prefersDark() ? 'rgba(10, 10, 10, 0.92)' : 'rgba(255, 255, 255, 0.92)',
    border: prefersDark() ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
    color: prefersDark() ? '#f5f5f5' : '#171717',
  })

  const heading = document.createElement('div')
  heading.textContent = 'Debug'
  Object.assign(heading.style, {
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    opacity: '0.75',
    textTransform: 'uppercase',
  })
  widget.appendChild(heading)

  const themeSection = document.createElement('div')
  Object.assign(themeSection.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  })

  const themeLabel = document.createElement('label')
  themeLabel.htmlFor = 'mppx-debug-theme'
  themeLabel.textContent = 'Theme'
  Object.assign(themeLabel.style, {
    fontSize: '11px',
    opacity: '0.7',
  })
  themeSection.appendChild(themeLabel)

  const themeSelect = document.createElement('select')
  themeSelect.id = 'mppx-debug-theme'
  themeSelect.setAttribute('aria-label', 'Theme')
  Object.assign(themeSelect.style, {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '8px',
    border: prefersDark() ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.08)',
    background: prefersDark() ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.8)',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  })
  for (const name of Object.keys(themes)) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    themeSelect.appendChild(option)
  }
  themeSelect.value = active
  themeSelect.onchange = () => {
    active = themeSelect.value
    writeParams()
    applyTheme()
    render()
  }
  themeSection.appendChild(themeSelect)

  const logoToggle = document.createElement('label')
  Object.assign(logoToggle.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    cursor: 'pointer',
  })
  const logoCheckbox = document.createElement('input')
  logoCheckbox.type = 'checkbox'
  logoCheckbox.checked = showLogo
  logoCheckbox.onchange = () => {
    showLogo = logoCheckbox.checked
    writeParams()
    applyTheme()
  }
  logoToggle.appendChild(logoCheckbox)
  logoToggle.appendChild(document.createTextNode('Logo'))
  themeSection.appendChild(logoToggle)

  widget.appendChild(themeSection)

  const stateSection = document.createElement('div')
  Object.assign(stateSection.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  })

  const stateLabel = document.createElement('div')
  stateLabel.textContent = 'State'
  Object.assign(stateLabel.style, {
    fontSize: '11px',
    opacity: '0.7',
  })
  stateSection.appendChild(stateLabel)

  const stateGrid = document.createElement('div')
  Object.assign(stateGrid.style, {
    display: 'grid',
    gap: '6px',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  })

  for (const [state, label] of [
    ['default', 'Default'],
    ['verifying', 'Verifying'],
    ['success', 'Success'],
    ['failed', 'Failed'],
  ] as const) {
    const button = document.createElement('button')
    button.textContent = label
    applyButtonStyles(button, { active: state === activeState })
    button.onclick = () => setDebugState(state)
    stateGrid.appendChild(button)
  }

  stateSection.appendChild(stateGrid)
  widget.appendChild(stateSection)
}

mediaQuery.addEventListener('change', () => {
  applyTheme()
  render()
})

render()
document.body.appendChild(widget)
applyTheme()
if (activeState !== 'default')
  window.dispatchEvent(new CustomEvent('mppx:debug-state', { detail: { state: activeState } }))
