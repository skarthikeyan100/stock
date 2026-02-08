import MongoClient, { Db, Collection } from 'mongodb'


export default class Mongo {
    dbUrl = 'mongodb://localhost:27017/stocks'
    dbName = 'stocks'
    db: Db
    client: MongoClient.MongoClient
    static instance: Mongo;

    async asyncForEach(array, callback) {
        for (let index = 0; index < array.length; index++) {
            await callback(array[index], index, array);
        }
    }

    static async init() {
        console.log("Mongo is initialized")
        if (!Mongo.instance) {
            Mongo.instance = new Mongo();
        }
        await Mongo.getInstance()._init(['trade', 'quote', 'NiftyQuote']);
    }

    static getInstance() {
        return Mongo.instance;
    }


    //TODO when to close db

    _init = async (collection: string[]) => {
        this.client = await MongoClient.connect(this.dbUrl, { useUnifiedTopology: true, ignoreUndefined: true })
        this.db = this.client.db(this.dbName);
        //Create initial collections
        const start = async () => {
            await this.asyncForEach(collection, async (element) => {
                await this.createCollection(element)
            });
        }
        console.log('Mongo is initialized')
        return this;
    }

    listCollections = async () => {

        const docs = await this.db.listCollections().toArray()
        console.log(docs)
        docs.forEach((doc, idx, array) => {
            console.log(doc.name);
            console.log(idx)
            console.log(array)
        })
    }

    createCollection = async (name) => {
        await this.db.createCollection(name)
    }

    //TODO quoteCollection is hard-coded
    insert = async (obj) => {
        await this.db.collection(obj.constructor.name).insertOne(obj)
    }

    close = async () => {
        await this.client.close()
    }

    getAll = (collectionName) => {
        try {
            const collection = this.db.collection(collectionName);
            console.log('Collection: ', collection)
            return collection.find({'day': 'Thursday'}).stream()
    
        } catch (e) {
            console.log(e);
        }
        
        
    }

};


