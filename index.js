const { OpenAIApi, Configuration } = require('openai')
const server = require('http').createServer()
const io = require('socket.io')(server, {
    cors: {
        origin: '*',
        maxHttpBufferSize: 1e8,
    },
})
require('dotenv').config()

let rooms = []

const openaiapi = new OpenAIApi(
    new Configuration({
        base: 'https://api.proxyapi.ru/openai/v1',
        apiKey: process.env.OPENAI_API_KEY,
    })
)

const generateResponseStream = async (prompt) => {
    try {
        const response = await openaiapi.createChatCompletion(
            {
                model: 'gpt-3.5-turbo',
                messages: prompt,
                temperature: 1,
                stream: true,
            },
            { responseType: 'stream' }
        )
        return response
    } catch (e) {
        return undefined
    }
}

const generateResponse = async (prompt) => {
    try {
        const response = await openaiapi.createChatCompletion({
            model: 'gpt-3.5-turbo',
            temperature: 1,
            messages: prompt,
        })
        return response.data.choices[0].message.content
    } catch (e) {
        return undefined
    }
}

const removeRoom = (id) => {
    rooms = rooms.filter((room) => {
        return room.id !== id
    })
}

const checkRoom = (id, roomID) => {
    let isFinded = false
    rooms.forEach((room) => {
        if (room.id === id && room.count < 10) {
            isFinded = true
        }
        if (room.id === id && room.count >= 10) {
            io.emit('message', {
                content:
                    'Извините, похоже произошел сбой на серверах openAI. Попробуйте еще раз.',
                type: 'nonstream',
                id: roomID,
            })
            removeRoom(id)
        }
    })
    return isFinded
}

const resend = ({ id, stream, messages, mid, system }) => {
    if (checkRoom(mid, id)) {
        setTimeout(() => {
            send({ id, stream, messages, mid, system })
        }, 3000)
    }
}

const addRoom = (id) => {
    let isFinded = false
    rooms = rooms.map((room) => {
        if (room.id === id) {
            room.count += 1
            isFinded = true
        }
        return room
    })
    if (!isFinded) {
        rooms.push({
            id,
            count: 0,
        })
    }
}

const send = async ({ id, stream, messages, mid, system }) => {
    addRoom(mid)
    let filtredMessages = [
        {
            role: 'system',
            content: system,
        },
    ]
    messages.map((message, index) => {
        if (
            (message.role === 'user' &&
                (messages[index + 1] == undefined ||
                    messages[index + 1].role !== 'user')) ||
            message.role === 'assistant'
        ) {
            filtredMessages.push({
                role: message.role,
                content: message.content,
            })
        }
    })

    if (stream === true) {
        const response = await generateResponseStream(filtredMessages)
        let isFirst = true
        let fullRes = ''

        try {
            response.data.on('data', (data) => {
                if (checkRoom(mid, id)) {
                    const lines = data
                        .toString()
                        .split('\n')
                        .filter((line) => line.trim() !== '')
                    for (const line of lines) {
                        const message = line.replace(/^data: /, '')
                        if (message === '[DONE]') {
                            io.emit('message', {
                                content: '',
                                type: 'end',
                                id,
                            })
                            removeRoom(mid)
                            return
                        } else {
                            try {
                                const parsed = JSON.parse(message)
                                if (
                                    parsed.choices[0].delta.content !==
                                        undefined &&
                                    checkRoom(mid, id)
                                ) {
                                    if (isFirst) {
                                        io.emit('message', {
                                            content:
                                                parsed.choices[0].delta.content,
                                            type: 'start',
                                            id,
                                        })
                                        isFirst = false
                                    } else {
                                        io.emit('message', {
                                            content:
                                                parsed.choices[0].delta.content,
                                            type: 'middle',
                                            id,
                                        })
                                    }
                                    fullRes += parsed.choices[0].delta.content
                                }
                            } catch {}
                        }
                    }
                }
            })
        } catch (e) {
            resend({ id, stream, messages, mid, system })
        }
    } else {
        const response = await generateResponse(filtredMessages)
        if (checkRoom(mid, id)) {
            if (response !== undefined) {
                io.emit('message', {
                    content: response,
                    type: 'nonstream',
                    id,
                })
                removeRoom(mid)
            } else {
                resend({ id, stream, messages, mid, system })
            }
        } else {
            removeRoom(mid)
        }
    }
}

io.on('connection', (socket) => {
    socket.on('message', send)

    socket.on('stop', (id) => removeRoom(id))

    socket.on('disconnect', () => {
        // console.log(`Client disconnected: ${socket.id}`)
    })
})

if (process.env.HOST) {
    server.listen(10000, process.env.HOST, () => {
        console.log('Server listening on port 10000')
    })
} else {
    server.listen(10000, () => {
        console.log('Server listening on port 10000')
    })
}
