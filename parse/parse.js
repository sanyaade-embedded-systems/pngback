// generic parse functions

(function(exports) {

var events = require('events');

var emitter = new events.EventEmitter(); // need to init to make this work.

var parse = Object.create(emitter);

parse.listen = function(stream) {
	var p = this;

	function data(ev) {
		p.data.call(p, ev);
	}

	function end() {
		p.end.call(p);
	}

	function unlisten() {
		stream.removeListener('data', data);
		stream.removeListener('end', end);
	}

	function pause() {
		stream.pause();
	}

	function resume() {
		stream.resume();
	}

	stream.on('data', data);
	stream.on('end', end);
	this.unlisten = unlisten;
	this.pause = pause;
	this.resume = resume;
	this.b = 0; // bit position, if used. Not that great having here.

	return this;
};

// the current deflate functions here are simpler, could have both in different versions
parse.data = function(buf) {
	while (typeof this.state == 'function' && buf.length) {
		var ret = this.state.call(this, 'data', buf);
			
		if (typeof ret == 'string') {
			this.emit('bad', ret);
			this.state = null;
		}
		
		buf = ret;
	}
		
	if (typeof this.state !== 'function') {
		this.unlisten();
	}
};
	
parse.end = function() {
	if (typeof this.state == 'function') { // can have non function eg if early error
		var ret = this.state.call(this, 'end');
			
		if (typeof ret == 'string') {
			this.emit('bad', ret);
			this.state = null;
		}
	}

	this.unlisten();

	this.emit('end');
};

parse.get = function(len, match, ev, buf, acc) {
		
	function again(ev, buf) {
		return this.get(len, match, ev, buf, acc);
	}
		
	if (ev != 'data') {
		return 'unexpected end of stream in get';
	}

	if (typeof acc == 'undefined') {
		acc = [];
	}

	var max = len - acc.length;
	max = (max > buf.length) ? buf.length : max;

	acc = acc.concat(Array.prototype.slice.call(buf, 0, max));
		
	buf = buf.slice(max);
						
	if (acc.length < len) {
		this.state = again;
		return buf;
	}

	var ret = match.call(this, acc);
	
	if (typeof ret == 'string') {
		return ret;
	}
		
	this.state = ret;

	return buf;
};
	
// we only use this in one place, could just use get and a match function that compares
parse.accept = function accept(bytes, success, ev, buf) {
	var compare;
	var c, v;
				
	function again(ev, buf) {
		return this.accept(compare, success, ev, buf);
	}
		
	if (bytes.length === 0) {
		this.state = success;
		return buf;
	}
		
	if (ev != 'data') {
		return 'unexpected end of stream in accept';
	}
		
	compare = bytes.slice();
		
	while (compare.length > 0 && buf.length > 0) {
		c = compare.shift();
		v = buf[0];
		buf = buf.slice(1);
		if (c != v) {
			return 'failed match';
		}
	}
				
	if (compare.length > 0) {
		this.state = again;
		return buf;
	}
		
	this.state = success;
	return buf;
};

// get bits
parse.getb = function(len, match, ev, buf, acc, acclen) {
	var b = this.b;	

	function again(ev, buf) {
		return this.getb(len, match, ev, buf, acc, acclen);
	}
			
	function mask(bs) {
		return (1 << bs) - 1;
	}
			
	if (ev != 'data') {
		return 'unexpected end of stream';
	}

	if (typeof acc == 'undefined') {
		acc = 0;
		acclen = 0;
	}
	
	var max, maxb, i, diff, bs, ret;

	do {
		max = len - acclen;
		maxb = buf.length * 8 - b;
		max = (max > maxb) ? maxb : max;

		i = 0;

		
		// first pull the bits out of the first possibly partial byte
		bs = (max < 8 - b) ? max : 8 - b;

		acc |= ((buf[i] >>> b) & mask(bs)) << acclen;
		acclen += bs;
		b += bs;

		if (b == 8) {
			i++;
			b = 0;
		}
			
		// now get the whole bytes
		while (bs - maxb > 8) {
			acc |= buf[i++] << acclen; // needs sign correction after 31 bits
			acclen += 8;
			bs += 8;
		}
		
		// now the remainder
		diff = bs - maxb;
		if (diff > 0) {
			acc |= (buf[i] & mask(diff)) << acclen;
			acclen += diff;
			bs += diff;
			b += diff;
		}
			
		if (i > 0) {
			buf = buf.slice(i);
		}

		this.b = b;

		if (acclen < len) {
			this.state = again;
			return buf;
		}

		ret = match(acc, len);

		if (typeof ret == 'string') {
			return ret;
		}

		if (typeof ret == 'number') { // need more bits
			len = ret;
		}
	} while (typeof ret == 'number');

	this.state = ret;
	return buf;
};


	exports.parse = parse;

})(typeof (exports === 'object') ? exports : this._parse = {});


