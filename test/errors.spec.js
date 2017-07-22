'use strict';

const GridFsStorage = require('../index');

const multer = require('multer');
const crypto = require('crypto');
const chai = require('chai');
const expect = chai.expect;
const request = require('supertest');
const express = require('express');
const settings = require('./utils/settings');
const mongo = require('mongodb');
const MongoClient = mongo.MongoClient;
const {files, cleanDb, version} = require('./utils/testutils');
const mute = require('mute');
const Promise = global.Promise || require('es6-promise');

const sinon = require('sinon');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);

describe('Error handling', function () {
  let storage, app, unmute, connectRef, randomBytesRef;

  before(() => {
    // TODO: Remove
    unmute = mute(process.stderr);
    app = express();
  });

  describe('Catching errors', function () {

    it('should fail gracefully if an error is thrown inside the configuration function', function (done) {
      let error;
      storage = GridFsStorage({
        url: settings.mongoUrl(),
        file: () => {
          throw new Error('Error thrown');
        }
      });

      const upload = multer({storage});

      app.post('/fail', upload.single('photo'), (err, req, res, next) => {
        error = err;
        next();
      });

      storage.on('connection', () => {
        request(app)
          .post('/fail')
          .attach('photo', files[0])
          .end(() => {
            expect(error).to.be.an('error');
            expect(error.message).to.equal('Error thrown');
            done();
          });
      });
    });

    it('should fail gracefully if an error is thrown inside a generator function', function (done) {
      let error;
      if (version.major < 6) {
        this.skip();
      }

      storage = GridFsStorage({
        url: settings.mongoUrl(),
        file: function*() {
          throw new Error('File error');
        }
      });

      const upload = multer({storage});

      app.post('/failgen', upload.single('photo'), (err, req, res, next) => {
        error = err;
        next();
      });

      storage.on('connection', () => {
        request(app)
          .post('/failgen')
          .attach('photo', files[0])
          .end(() => {
            expect(error).to.be.an('error');
            expect(error.message).to.equal('File error');
            done();
          });
      });
    });
  });

  it('should emit an error event when the file streaming fails', function (done) {
    let db, fs, error;
    const errorSpy = sinon.spy();

    MongoClient
      .connect(settings.mongoUrl())
      .then((_db) => db = _db)
      .then(() => fs = db.collection('fs.files'))
      .then(() => fs.createIndex('md5', {unique: true}))
      .then(() => {

        storage = GridFsStorage({url: settings.mongoUrl()});

        const upload = multer({storage});

        app.post('/emit', upload.array('photos', 2), (err, req, res, next) => {
          error = err;
          next();
        });

        storage.on('streamError', errorSpy);

        request(app)
          .post('/emit')
          // Send the same file twice so the checksum is the same
          .attach('photos', files[0])
          .attach('photos', files[0])
          .end(() => {
            expect(errorSpy).to.be.calledOnce;
            expect(error).to.be.an.instanceOf(Error);
            const call = errorSpy.getCall(0);
            expect(call.args[0]).to.be.an.instanceOf(Error);
            expect(call.args[1]).to.have.all.keys('chunkSize', 'contentType', 'filename', 'metadata', 'bucketName', 'id');
            done();
          });
      });


    after(() => cleanDb(storage));
  });

  describe('MongoDb connection', function () {

    describe('Connection function fails to connect', function () {
      let err;

      before(() => {
        connectRef = mongo.MongoClient.connect;
        err = new Error();

        mongo.MongoClient.connect = function (url, options, cb) {
          cb(err);
        };
      });

      it('should throw an error if the mongodb connection fails', function (done) {
        const connectionSpy = sinon.spy();

        storage = GridFsStorage({
          url: settings.mongoUrl()
        });

        storage.once('connectionFailed', connectionSpy);

        setTimeout(() => {
          expect(connectionSpy).to.be.calledOnce;
          done();
        });
      });

      after(() => mongo.MongoClient.connect = connectRef);
    });

    describe('Connection is not opened', function () {
      let error;

      before((done) => {
        const promise = mongo.MongoClient.connect(settings.mongoUrl())
          .then((db) => {
            process.nextTick(() => {
              db.close();
            });
            return db;
          });

        storage = GridFsStorage({
          db: promise
        });
        const upload = multer({storage});

        app.post('/close', upload.array('photos', 2), (err, req, res, next) => {
          error = err;
          next();
        });

        request(app)
          .post('/close')
          .attach('photos', files[0])
          .attach('photos', files[0])
          .end(done);
      });

      it('should throw an error if database connection is not opened', function () {
        expect(error).to.be.an('error');
        expect(error.message).to.equal('The database connection must be open to store files');
      });
    });

    describe('Connection promise fails to connect', function () {
      let error, errorSpy = sinon.spy();

      before((done) => {
        error = new Error('Failed promise');

        const promise = mongo.MongoClient.connect(settings.mongoUrl())
          .then(() => {
            return Promise.reject(error);
          });

        storage = GridFsStorage({
          db: promise
        });

        storage.on('connectionFailed', errorSpy);

        const upload = multer({storage});

        app.post('/close', upload.array('photos', 2), (err, req, res, next) => {
          error = err;
          next();
        });

        request(app)
          .post('/close')
          .attach('photos', files[0])
          .attach('photos', files[0])
          .end(done);
      });

      it('should emit an error if the connection fails to open', function () {
        expect(errorSpy).to.be.calledOnce;
      });

      it('should set the database instance to null', function () {
        expect(storage.db).to.equal(null);
      });
    });
  });

  describe('Crypto module', function () {
    let error, generatedError;

    before(() => {
      randomBytesRef = crypto.randomBytes;
      generatedError = new Error('Random bytes error');

      crypto.randomBytes = function (size, cb) {
        if (cb) {
          return cb(generatedError);
        }
        throw generatedError;
      };
    });

    it('should result in an error if the randomBytes function fails', function (done) {
      storage = GridFsStorage({
        url: settings.mongoUrl()
      });

      const upload = multer({storage});

      app.post('/randombytes', upload.single('photo'), (err, req, res, next) => {
        error = err;
        next();
      });

      storage.on('connection', () => {
        request(app)
          .post('/randombytes')
          .attach('photo', files[0])
          .end(() => {
            expect(error).to.equal(generatedError);
            expect(error.message).to.equal('Random bytes error');
            done();
          });
      });
    });

    after(() => crypto.randomBytes = randomBytesRef);
  });

  after(() => unmute());

});
